package hub

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/knadh/niltalk/store"
	"golang.org/x/crypto/nacl/box"
)

//JSDateFormat is compatible with javascript date.parse API.
var JSDateFormat = "2006-01-02T15:04:05.000Z"

type UnsealedMsg struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

type SealedMsg struct {
	Data  interface{} `json:"data"`
	To    string      `json:"to"`
	From  string      `json:"from"`
	Nonce string      `json:"nonce"`
}

type roomPublicKeyMsg struct {
	Type      string `json:"type"`
	PublicKey string `json:"publicKey"`
}

type motdMsg struct {
	Type string `json:"type"`
	Msg  string `json:"message"`
}

type peerMsg struct {
	Type      string `json:"type"`
	PublicKey string `json:"publicKey"`
	Since     string `json:"since"`
}

type peerListMsg struct {
	Type  string    `json:"type"`
	Peers []peerMsg `json:"peers"`
}

// peerReq represents a peer request (join, leave etc.) that's processed
// by a Room.
type peerReq struct {
	reqType string
	peer    *Peer
}

type peerList map[*Peer]bool

func (l peerList) peerMsgList(connected bool) (ret []peerMsg) {
	for p := range l {
		if (connected && p.ws != nil) || !connected {
			ret = append(ret, peerMsg{PublicKey: p.PublicKey, Since: p.Since.Format(JSDateFormat)})
		}
	}
	return ret
}

func (l peerList) MarshalJSON() ([]byte, error) {
	panic("nop")
	return json.Marshal(l.peerMsgList(true))
}

func (l peerList) byPublicKey(pk string) *Peer {
	for p := range l {
		if p.PublicKey == pk {
			return p
		}
	}
	return nil
}

// Room represents a chat room.
type Room struct {
	ID              string
	Name            string
	Password        []byte
	Predefined      bool
	PredefinedUsers []PredefinedUser

	hub *Hub

	lastActivity time.Time

	// List of connected peers.
	peers peerList

	// Broadcast channel for messages.
	broadcastUnsealed chan interface{}
	broadcastSealed   chan []byte
	forwardQ          chan SealedMsg

	// GrowlHandler is an async callback fired when a peer notifies an offline predefined users.
	GrowlHandler func(msg, handle, token string)
	growlTokens  *tokenStore

	// Peer related requests.
	peerConnect chan peerConnect
	peerQ       chan peerReq

	// Dispose signal.
	disposeSig chan bool

	op chan func()

	timestamp time.Time

	// Message Of The Day
	motd string

	// keys to sign messages emitted by the server for this room
	PubKey  *[32]byte
	SPubKey string
	privKey *[32]byte
}

// NewRoom returns a new instance of Room.
func NewRoom(id, name string, h *Hub, predefined bool) *Room {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatalf("failed to generate random signature keys: %v", err)
	}
	return &Room{
		ID:                id,
		Name:              name,
		Predefined:        predefined,
		hub:               h,
		peers:             make(map[*Peer]bool, 100),
		broadcastUnsealed: make(chan interface{}, 100),
		broadcastSealed:   make(chan []byte, 100),
		peerConnect:       make(chan peerConnect, 100),
		peerQ:             make(chan peerReq, 100),
		forwardQ:          make(chan SealedMsg, 100),
		disposeSig:        make(chan bool),
		growlTokens:       newTokenStore(),
		op:                make(chan func()),
		SPubKey:           base64.StdEncoding.EncodeToString(pub[:]),
		PubKey:            pub,
		privKey:           priv,
	}
}

// Login an user into the room. It chekcs for room password,
// user password is the handle belongs to a predefined user.
// Generates a session ID and stores it into the store.
func (r *Room) Login(secret, spubkey string) (*Peer, error) {
	var pubkey [32]byte
	z, err := base64.StdEncoding.DecodeString(spubkey)
	if err != nil {
		return nil, err
	}
	copy(pubkey[:], z)

	if secret == "" {
		rnds, err := GenerateGUID(10)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(append([]byte(rnds), pubkey[:]...))
		secret = fmt.Sprintf("%x", sum)
	}

	since := time.Now().UTC()

	var wg sync.WaitGroup
	wg.Add(1)
	peer := newPeer(secret, spubkey, pubkey, since, r)
	r.op <- func() {
		defer wg.Done()
		err = r.login(peer)
	}
	wg.Wait()
	return peer, err
}

func (r *Room) login(peer *Peer) error {
	for p := range r.peers {
		if p.PublicKey == peer.PublicKey {
			return ErrAlreadyConnected
		}
	}
	if len(r.peers)+1 > r.hub.cfg.MaxPeersPerRoom {
		return ErrRoomCapacityExceded
	}
	r.peers[peer] = false
	return nil
}

// Predefined common errors.
var (
	ErrInvalidRoomPassword = fmt.Errorf("invalid room password")
	ErrInvalidUserPassword = fmt.Errorf("invalid user password")
	ErrAlreadyConnected    = fmt.Errorf("user is already connected")
	ErrInvalidToken        = fmt.Errorf("invalid autologin token")
	ErrRoomCapacityExceded = fmt.Errorf("maximum room cpacity exceeded")
)

// HandleGrowlNotifications sends growl notification if target user is offline.
func (r *Room) HandleGrowlNotifications(fromPeer, to, msg string) {
	if r.GrowlHandler == nil {
		return
	}
	var ok bool
	for _, u := range r.PredefinedUsers {
		if u.Growl && u.Name == to {
			ok = true
			break
		}
	}
	if !ok {
		return
	}

	r.op <- func() {
		//generate a login token, send the notification
		tok := r.growlTokens.createToken(to)
		if tok != "" {
			go r.GrowlHandler(msg, fromPeer, tok)
		}
	}
}

// GetLoginTokens returns the list of tokens to give peers to authentify peer login.
func (r *Room) GetLoginTokens(authlogintoken string) (string, map[string]SealedMsg, error) {

	handle := r.growlTokens.checkToken(authlogintoken)
	if len(handle) < 1 {
		return "", nil, ErrInvalidToken
	}

	type authsecret struct {
		Secret string `javascript:"secret"`
		Date   string `javascript:"date"`
	}
	sealedMsgs := map[string]SealedMsg{}
	var wg sync.WaitGroup
	wg.Add(1)
	r.op <- func() {
		for p := range r.peers {
			m := r.sealedMsg(p, authsecret{
				Secret: p.Secret,
				Date:   time.Now().UTC().Format(JSDateFormat),
			})
			sealedMsgs[p.PublicKey] = m
		}
		wg.Done()
	}
	wg.Wait()

	return handle, sealedMsgs, nil
}

type peerConnect struct {
	ws        *websocket.Conn
	publicKey string
}

// ConnectPeer connects a peer to the room given a WS connection from an HTTP
// handler.
func (r *Room) ConnectPeer( /*id, handle,*/ publicKey string, ws *websocket.Conn) {
	r.peerConnect <- peerConnect{
		ws:        ws,
		publicKey: publicKey,
	}
}

// GetSession retrieves peer session info.
func (r *Room) GetSession(publicKey string) (store.Sess, bool) {
	var s store.Sess
	var ok bool
	var wg sync.WaitGroup
	wg.Add(1)
	r.op <- func() {
		defer wg.Done()
		for p := range r.peers {
			if p.PublicKey == publicKey {
				s.PublicKey = publicKey
				s.Since = p.Since
				ok = true
				break
			}
		}
	}
	wg.Wait()
	return s, ok
}

// Dispose signals the room to notify all connected peer messages, and dispose
// of itself.
func (r *Room) Dispose() {
	r.disposeSig <- true
}

// BroadcastUnsealed broadcasts an unsealed message to all connected peers.
func (r *Room) BroadcastUnsealed(data interface{} /*, record bool*/) {
	r.broadcastUnsealed <- data
}

// BroadcastSealed broadcasts a sealed message to all connected peers.
func (r *Room) BroadcastSealed(data SealedMsg /*, record bool*/) {
	r.broadcastSealed <- r.encode(data)
}

// Forward forward a message to the recipient.
func (r *Room) Forward(data SealedMsg) {
	r.forwardQ <- data
}

// run is a blocking function that starts the main event loop for a room that
// handles peer connection events and message broadcasts. This should be invoked
// as a goroutine.
func (r *Room) run() {
	tMin := time.NewTicker(time.Minute)
loop:
	for {
		select {
		case op := <-r.op:
			op()

		// Dispose request.
		case <-r.disposeSig:
			if r.Predefined {
				continue
			}
			break loop

		case sealedMsg, ok := <-r.forwardQ:
			if !ok {
				break loop
			}
			if sealedMsg.To == r.SPubKey {
				r.hub.log.Printf("got unwanted message in Room.run loop, to key must not be the room server key")
				continue
			}
			p := r.peers.byPublicKey(sealedMsg.To)
			if p != nil {
				p.SendData(r.encode(sealedMsg))
				continue
			}
			for p := range r.peers {
				p.SendData(r.encode(sealedMsg))
			}

		case info, ok := <-r.peerConnect:
			if !ok {
				break loop
			}

			peer := r.peers.byPublicKey(info.publicKey)
			if peer == nil {
				info.ws.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, TypeMustLogin), time.Time{})
				info.ws.Close()
				r.hub.log.Printf("peer %q did not login", info.publicKey)
				continue
			}
			peer.Connect(info.ws)

			r.peers[peer] = true
			go peer.RunListener()
			go peer.RunWriter()

			// Send the peer its info.
			data := peerListMsg{Type: TypePeerList, Peers: r.peers.peerMsgList(true)}
			peer.SendData(r.sealData(peer, data))

			if len(r.motd) > 0 {
				motd := motdMsg{
					Type: TypeMotd,
					Msg:  r.motd,
				}
				peer.SendData(r.sealData(peer, motd))
			}

			// Notify all peers of the new addition.
			peerJoin := peerMsg{
				Type:      TypePeerJoin,
				PublicKey: peer.PublicKey,
				Since:     peer.Since.Format(JSDateFormat),
			}
			r.BroadcastUnsealed(peerJoin)
			r.hub.log.Printf("%s joined %s", peer.PublicKey, r.ID)

		// Incoming peer request.
		case req, ok := <-r.peerQ:
			if !ok {
				break loop
			}

			switch req.reqType {
			// A peer has left.
			case TypePeerLeave:
				r.removePeer(req.peer)
				peerLeave := peerMsg{
					Type:      TypePeerLeave,
					PublicKey: req.peer.PublicKey,
					Since:     req.peer.Since.Format(JSDateFormat),
				}
				r.BroadcastUnsealed(peerLeave)
				r.hub.log.Printf("%s left %s", req.peer.PublicKey, r.ID)

			// A peer has requested the room's peer list.
			case TypePeerList:
				data := peerListMsg{Type: TypePeerList, Peers: r.peers.peerMsgList(true)}
				req.peer.SendData(r.sealData(req.peer, data))
			}

		// Fanout unsealed broadcast to all peers.
		case m, ok := <-r.broadcastUnsealed:
			if !ok {
				break loop
			}

			for p := range r.peers {
				p.SendData(r.sealData(p, m))
			}

			r.extendTTL()

			// Fanout sealed broadcast to all peers.
		case m, ok := <-r.broadcastSealed:
			if !ok {
				break loop
			}

			for p := range r.peers {
				p.SendData(m)
			}

			r.extendTTL()

		// Kill the room after the inactivity period.
		case <-time.After(r.hub.cfg.RoomAge):
			break loop

		case <-tMin.C:
			for p := range r.peers {
				if p.ws != nil {
					continue
				}
				if !p.lastMessage.IsZero() && p.lastMessage.Add(time.Minute*5).Before(time.Now()) {
					delete(r.peers, p)
				}
				if p.lastMessage.IsZero() && p.Since.Add(time.Minute*5).Before(time.Now()) {
					delete(r.peers, p)
				}
			}
		}
	}

	r.hub.log.Printf("stopped room: %v", r.ID)
	r.remove()
}

// extendTTL extends a room's TTL in the store.
func (r *Room) extendTTL() {
	// Extend the room's expiry (once every 30 seconds).
	if !r.Predefined && time.Since(r.timestamp) > time.Duration(30)*time.Second {
		r.timestamp = time.Now()
	}
}

// remove disposes a room by notifying and disconnecting all peers and
// removing the room from the store.
func (r *Room) remove() {
	// Close all peer WS connections.
	for peer := range r.peers {
		peer.writeWSControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, TypeRoomDispose))
		delete(r.peers, peer)
	}

	// Close all room channels.
	close(r.broadcastUnsealed)
	close(r.broadcastSealed)
	close(r.peerQ)
	close(r.forwardQ)
	r.hub.removeRoom(r.ID)
}

// queuePeerReq queues a peer addition / removal request to the room.
func (r *Room) queuePeerReq(reqType string, peer *Peer) {
	r.peerQ <- peerReq{peer: peer, reqType: reqType}
}

// removePeer removes a peer from the room and broadcasts a message to the
// room notifying all peers of the action.
func (r *Room) removePeer(p *Peer) {
	close(p.dataQ)
	delete(r.peers, p)
}

// HandleMessage handles incoming peer message.
func (r *Room) HandleMessage(m SealedMsg, peer *Peer) {
	if m.To != r.SPubKey {
		r.Forward(m)
		return
	}

	sdata, ok := m.Data.(string)
	if !ok {
		r.hub.log.Printf("invalid message type: %T", m.Data)
		return
	}

	b, err := base64.StdEncoding.DecodeString(sdata)
	if err != nil {
		r.hub.log.Printf("invalid message data: %v", err)
		return
	}
	var nonce [24]byte
	z, err := base64.StdEncoding.DecodeString(m.Nonce)
	if err != nil {
		r.hub.log.Printf("invalid message nonce: %v", err)
		return
	}
	copy(nonce[:], z)
	var from [32]byte
	y, err := base64.StdEncoding.DecodeString(m.From)
	if err != nil {
		r.hub.log.Printf("invalid message from: %v", err)
		return
	}
	copy(from[:], y)

	x, ok := box.Open(nil, b, &nonce, &from, r.privKey)
	if !ok {
		r.hub.log.Printf("invalid message: %v", err)
		return
	}

	var dm UnsealedMsg
	if err := json.Unmarshal(x, &dm); err != nil {
		// TODO: Respond
		return
	}

	switch dm.Type {
	case TypeRoomDispose:
		r.Dispose()
	case TypePeerList:
		r.queuePeerReq(dm.Type, peer)
	case TypeUploading:
	// 	data, ok := m.Data.(map[string]interface{})
	// 	if !ok {
	// 		// TODO: Respond
	// 		return
	// 	}
	// 	p.room.Broadcast(p.room.makeUploadPayload(data, p, m.Type) /*, false*/)

	case TypeUpload:
		// // 	// Check rate limits and update counters.
		// // 	now := time.Now()
		// // 	if p.numMessages > 0 {
		// // 		if (p.numMessages%p.room.hub.cfg.RateLimitMessages+1) >= p.room.hub.cfg.RateLimitMessages &&
		// // 			time.Since(p.lastMessage) < p.room.hub.cfg.RateLimitInterval {
		// // 			// p.room.hub.Store.RemoveSession(p.ID, p.room.ID)
		// // 			p.writeWSControl(websocket.CloseMessage,
		// // 				websocket.FormatCloseMessage(websocket.CloseNormalClosure, TypePeerRateLimited))
		// // 			p.ws.Close()
		// // 			return
		// // 		}
		// // 	}
		// // 	p.lastMessage = now
		// // 	p.numMessages++
		// //
		// // 	msg, ok := m.Data.(map[string]interface{})
		// // 	if !ok {
		// // 		// TODO: Respond
		// // 		return
		// // 	}
		// // 	p.room.Broadcast(p.room.makeUploadPayload(msg, p, m.Type) /*, true*/)
	case TypeGrowl:
		data, ok := dm.Data.(map[string]interface{})
		if !ok {
			// TODO: Respond
			return
		}
		var to string
		{
			x, ok := data["to"]
			if ok {
				to, _ = x.(string)
			}
		}
		var from string
		{
			x, ok := data["from"]
			if ok {
				from, _ = x.(string)
			}
		}
		var msg string
		{
			x, ok := data["msg"]
			if ok {
				msg, _ = x.(string)
			}
		}

		r.HandleGrowlNotifications(from, to, msg)

	default:
		r.hub.log.Printf("invalid message type: %v", dm.Type)
	}
}

// sendPeerList sends the peer list to the given peer.
func (r *Room) sendPeerList(p *Peer) {
	r.peerQ <- peerReq{reqType: TypePeerList, peer: p}
}

// // makeMessagePayload prepares a chat message.
// func (r *Room) makeMessagePayload(msg string, p *Peer, typ string) []byte {
// 	d := payloadMsgChat{
// 		// PeerID:     p.ID,
// 		// PeerHandle: p.Handle,
// 		PublicKey: p.PublicKey,
// 		Msg:       msg,
// 	}
// 	return r.sealData(p, d, typ)
// }
//
// // makeUploadPayload prepares an upload message.
// func (r *Room) makeUploadPayload(data interface{}, p *Peer, typ string) []byte {
// 	d := payloadUpload{
// 		// PeerID:     p.ID,
// 		// PeerHandle: p.Handle,
// 		PublicKey: p.PublicKey,
// 		Data:      data,
// 	}
// 	return r.makePayload(d, typ)
// }
//
// // makePayload prepares a message payload.
// func (r *Room) makePayload(data interface{}, typ string) []byte {
// 	bb, _ := json.Marshal(data)
// 	out := make([]byte, 0, sign.Overhead+len(bb))
// 	ret := sign.Sign(out, bb, r.privKey)
// 	m := payloadMsgWrap{
// 		Timestamp: time.Now(),
// 		Type:      typ,
// 		Data:      base64.StdEncoding.EncodeToString(ret),
// 	}
// 	b, _ := json.Marshal(m)
// 	return b
// }

// seal a message with server key.
func (r *Room) sealedMsg(to *Peer, data interface{}) SealedMsg {
	msg, _ := json.Marshal(data)

	var nonce [24]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		panic(err)
	}

	encrypted := box.Seal(nil, msg, &nonce, &to.BPublicKey, r.privKey)
	m := SealedMsg{
		From:  r.SPubKey,
		Data:  base64.StdEncoding.EncodeToString(encrypted),
		Nonce: base64.StdEncoding.EncodeToString(nonce[:]),
		To:    to.PublicKey,
	}
	return m
}

// seal a message with server key.
func (r *Room) sealData(to *Peer, data interface{}) []byte {
	return r.encode(r.sealedMsg(to, data))
}

// encode data json.
func (r *Room) encode(data interface{}) []byte {
	b, _ := json.Marshal(data)
	return b
}
