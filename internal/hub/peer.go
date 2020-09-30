package hub

import (
	"encoding/json"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

// Peer represents an individual peer / connection into a room.
type Peer struct {
	BPublicKey [32]byte
	PublicKey  string
	Since      time.Time
	Secret     string

	ws *websocket.Conn

	// Channel for outbound messages.
	dataQ chan []byte

	// Peer's room.
	room *Room

	lastMessage time.Time
}

type peerInfo struct {
	ID     string `json:"id"`
	Handle string `json:"handle"`
}

// newPeer returns a new instance of Peer.
func newPeer(secret, spubKey string, publicKey [32]byte, since time.Time, room *Room) *Peer {
	return &Peer{
		Secret:     secret,
		PublicKey:  spubKey,
		BPublicKey: publicKey,
		Since:      since,
		dataQ:      make(chan []byte, 100),
		room:       room,
	}
}

// Connect saves peer socket handler.
func (p *Peer) Connect(ws *websocket.Conn) {
	p.ws = ws
}

// RunListener is a blocking function that reads incoming messages from a peer's
// WS connection until its dropped or there's an error. This should be invoked
// as a goroutine.
func (p *Peer) RunListener() {
	rl := rate.NewLimiter(rate.Every(time.Second), 3)
	p.ws.SetReadLimit(int64(p.room.hub.cfg.MaxMessageLen))
	for {
		_, m, err := p.ws.ReadMessage()
		if err != nil {
			break
		}
		if len(m) < 1 {
			continue
		}
		if rl.Allow() {
			p.processMessage(m)
		}
	}

	// WS connection is closed.
	p.ws.Close()
	p.room.queuePeerReq(TypePeerLeave, p)
}

// RunWriter is a blocking function that writes messages in a peer's queue to the
// peer's WS connection. This should be invoked as a goroutine.
func (p *Peer) RunWriter() {
	defer p.ws.Close()
	for {
		select {
		// Wait for outgoing message to appear in the channel.
		case message, ok := <-p.dataQ:
			if !ok {
				p.writeWSData(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.writeWSData(websocket.TextMessage, message); err != nil {
				return
			}
		}
	}
}

// SendData queues a message to be written to the peer's WS.
func (p *Peer) SendData(b []byte) {
	p.dataQ <- b
}

// writeWSData writes the given payload to the peer's WS connection.
func (p *Peer) writeWSData(msgType int, payload []byte) error {
	p.ws.SetWriteDeadline(time.Now().Add(p.room.hub.cfg.WSTimeout))
	return p.ws.WriteMessage(msgType, payload)
}

// writeWSControl writes the given control payload to the peer's WS connection.
func (p *Peer) writeWSControl(control int, payload []byte) error {
	return p.ws.WriteControl(websocket.CloseMessage, payload, time.Time{})
}

// processMessage processes incoming messages from peers.
func (p *Peer) processMessage(b []byte) {
	var m SealedMsg
	if err := json.Unmarshal(b, &m); err != nil {
		// TODO: Respond
		return
	}
	p.lastMessage = time.Now()
	p.room.HandleMessage(m, p)
}
