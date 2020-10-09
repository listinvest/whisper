
var MsgType = MsgType || {};
MsgType.PeerList = "peer.list";
MsgType.PeerJoin = "peer.join";
MsgType.PeerLeave = "peer.leave";
MsgType.ChallengeQuery = "challenge.query";
MsgType.ChallengeResponse = "challenge.response";
MsgType.Message = "message";

var EvType = EvType || {};
EvType.Error = "error";
EvType.Message = "message";
EvType.Accept = "accept";
EvType.PeerConnect = "peer.connect";
EvType.PeerDisconnect = "peer.disconnect";
EvType.PeerAccept = "peer.accept";
EvType.PeerLeave = "peer.leave";
EvType.PeerRenewHandle = "renew.peerhandle";
EvType.RenewMyHandle = "renew.myhandle";
EvType.Negotiating = "negotiating";

var ChResults = ChResults || {};
ChResults.PeerNotFound = "peer-not-found";
ChResults.InProgress = "in-progress";
ChResults.InvalidHash = "invalid-hash";
ChResults.DuplicateHandle = "duplicate.handle";
ChResults.InvalidSealedAuth = "invalid.sealedauth";
ChResults.OK = "ok";

class Whisper {
  constructor () {
    this.events = new EventEmitter();
    this.msgDispatcher = new EventEmitter();

    this.roomID = null;


    this.me = {};
    this.peers = [];

    this.transport = null;

    // b64 encoded server public key
    this.serverpubkey = null;

    // {from: public key b64, key: {publicKey: b64, secret: b64}, since: Date}
    this.sharedKeys = [];

    // pubkey=>{token, since, result}
    this.tokens = {};
    this.peerStatus = {};

    this.mycrypto = new CryptoUtils();
    this.mesharedcrypto = new CryptoUtils();
  }

  // on register an event listener.
  on (ev, handle, opts) {
     return this.events.on(ev, handle, opts);
  }

  // once register a listener that triggers once.
  once (ev, handle, opts) {
   return this.events.once(ev, handle, opts);
  }

  // off removes an event listener from an event.
  off (ev, handle, opts) {
  if (!handle) {
    return this.events.removeAllListeners(ev);
  }
   return this.events.off(ev, handle, opts);
  }

  // trigger an event with its argument.
  trigger () {
    var args = Array.from(arguments);
    return this.events.emit.apply(this.events, args);
  }

  // connect on given transport. It implements connects, send, on, off.
  // It triggers connect, error, disconnect, message
  connect (transport, serverpubkey, me) {
    if (this.transport){
      this.close();
    }
    this.transport = transport;
    this.me = me
    this.serverpubkey = serverpubkey;
    this.msgDispatcher.once(MsgType.PeerList, this.onPeers.bind(this))
    this.msgDispatcher.on(MsgType.ChallengeQuery, this.onChallengeQuery.bind(this))
    this.msgDispatcher.on(MsgType.ChallengeResponse, this.onChallengeResponse.bind(this))
    this.msgDispatcher.on(MsgType.PeerJoin, this.onPeerJoinLeave.bind(this))
    this.msgDispatcher.on(MsgType.PeerLeave, this.onPeerJoinLeave.bind(this))
    this.transport.on(EvType.Message, this.onTransportMessage.bind(this))
    this.transport.on(EvType.Error, this.onTransportError.bind(this))
  }

  // close the underlying transport.
  // triggers diconnect event.
  close () {
    this.msgDispatcher.removeAllListeners(MsgType.PeerList)
    this.msgDispatcher.removeAllListeners(MsgType.ChallengeQuery)
    this.msgDispatcher.removeAllListeners(MsgType.ChallengeResponse)
    this.msgDispatcher.removeAllListeners(MsgType.PeerJoin)
    this.msgDispatcher.removeAllListeners(MsgType.PeerLeave)
    if (this.transport) {
      this.transport.off(EvType.Message)
      this.transport.off(EvType.Error)
    }
    this.transport = null;
    this.serverpubkey = "";
    this.me = {};
    this.sharedKeys = []
    this.peers = []
  }

  // onTransportError handles transport error.
  onTransportError (err) {
    this.trigger(EvType.Error, err)
  }

  // onTransportMessage decodes input message and triggers the related event handler.
  onTransportMessage (message) {
    var msg = {};
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("failed to json parse message ", e);
      return null;
    }
		var foundkey=null;
		if (msg.to === this.mycrypto.publicKey()){
			foundkey = this.mycrypto.get()
		} else {
      foundkey = this.sharedKeys.filter( this.isSharedPubkey(msg.to) ).pop()
      if (foundkey) {
        foundkey = foundkey.key
      }
		}
    if (!foundkey) {
      console.error("key not found for ", msg)
      return
    }

		const data = nacl.util.decodeBase64(msg.data);
		const nonce = nacl.util.decodeBase64(msg.nonce);
		const remotePubKey = nacl.util.decodeBase64(msg.from);
		const secretKey = nacl.util.decodeBase64(foundkey.secretKey);
		const scleardata = nacl.box.open(data, nonce, remotePubKey, secretKey);
		if (!scleardata) {
			console.error("foundkey ", foundkey)
			console.error("msg not decrypted ", msg)
			return
		}
		var cleardata = JSON.parse(nacl.util.encodeUTF8(scleardata));
    // console.log("rcv", this.mycrypto.publicKey(), msg.from, cleardata)
    if (this.msgDispatcher.getListeners(cleardata.type).length>0){
      this.msgDispatcher.emit(cleardata.type, cleardata, msg);
    }else{
      this.trigger(cleardata.type, cleardata, msg);
    }
  }

	// send, encrypt and authenticate a message usiing our keys to given public key.
	send(msg, b64ToPubKey) {
    // console.log("snd", this.mycrypto.publicKey(), b64ToPubKey, msg)
		const nonce = this.mycrypto.newNonce();
		const data = this.mycrypto.encrypt(JSON.stringify(msg), nonce, b64ToPubKey);
		const bPub = this.mycrypto.publicKey();
		const err = this.transport.send({ "data": data, "nonce": nonce, "from": bPub, "to": b64ToPubKey });
    if (err){
      console.error(err)
    }
	}

	// broadcast, encrypt and authenticate a message using given sharedKey.
	broadcast (msg) {
    // console.log("brd", this.mycrypto.publicKey(), msg)
    const oldest = this.peers.filter(this.iAccepted).sort(this.sortBySince).pop();
    if (!oldest) {
      console.error("could not find a peer to send message")
      return
    }
    const key = this.sharedKeys.filter( this.withKey ).filter( this.isFrom(oldest.publicKey) ).pop();
    if (!key) {
      console.error("could not find peer shared keys to send message")
      return
    }
    if (!key.key) {
      console.error("could not get peer shared keys to send message")
      return
    }
		const bPub = this.mycrypto.publicKey();
		var crypto = new CryptoUtils(key.key);
		const nonce = crypto.newNonce();
		const data = this.mycrypto.encrypt(JSON.stringify(msg), nonce, crypto.publicKey());
		this.transport.send({ "data": data, "nonce": nonce, "from": bPub, "to": key.key.publicKey });
	}

	// broadcastDirect send a message to each accepted peer.
	broadcastDirect (msg) {
    // console.log("brdd", msg)
    var that = this;
    this.peers.filter(this.iAccepted).map( (p)=>{
      that.send(msg, p.publicKey)
    })
	}

  newToken(publicKey) {
    this.trigger(EvType.Negotiating, this.cntNegotiations())
    this.tokens[publicKey] = {
      token: makeid(16),
      since: new Date(),
      result: ChResults.InProgress,
    }
    return this.tokens[publicKey];
  }
  validateToken(publicKey, token, result) {
    if (!this.tokens[publicKey]) {
      return false
    }
    const curNego = this.tokens[publicKey];
    if( curNego.token!==token){
      return false
    }
    var maxElapsed = 60 * 5; //5 minutes
    if (this.isBefore(curNego.since, maxElapsed)) {
      console.error("invalid token: lifetime exceeded");
      return false
    }
    if (curNego.result == ChResults.InProgress) {
      curNego.result = result;
      return true
    }
    return false
  }
  cntNegotiations() {
    return Object.keys(this.tokens).filter((p)=>{
      return this.tokens[p].result === ChResults.InProgress
    }).length;
  }

  isPeerStatus(publicKey) {
    return this.peerStatus[publicKey] && this.peerStatus[publicKey]===ChResults.OK;
  }
  // setPeerStatus for a remote.
  setPeerStatus(publicKey, status) {
    this.peerStatus[publicKey] = status;
  }
  // cntPeerStatus for a remote.
  cntPeerStatus(publicKey, status) {
    return Object.keys(this.peerStatus).filter((k)=>{
      return this.peerStatus[k]===status;
    }).length;
  }

  onPeerJoinLeave(cleardata, data) {
    if (data.from!==this.serverpubkey){
      console.error("must be issued by the server", data, cleardata)
      return
    }
    const bPub = this.mycrypto.publicKey();
    const peer = cleardata;
    if (peer.publicKey===bPub){
      return
    }

    // Add / remove the peer from the existing list.
    if (cleardata.type === MsgType.PeerJoin) {
      delete(peer.type)
      this.peers.push(peer);
      this.trigger(EvType.PeerConnect, peer)
      this.issueChallenge(peer.publicKey);
      return
    }

    var thispeer = this.peers.filter( this.isPubKey(cleardata.publicKey) ).shift();
    if (thispeer){
      if (this.isPeerStatus(cleardata.publicKey, ChResults.OK)) {
        this.trigger(EvType.PeerLeave, thispeer)
      }
      this.sharedKeys = this.sharedKeys.filter( this.notFrom(cleardata.publicKey) )
      this.peers = this.peers.filter( this.notPubKey(cleardata.publicKey) );
      delete this.peerStatus[cleardata.publicKey];
      delete this.tokens[cleardata.publicKey];
      this.trigger(EvType.PeerDisconnect, thispeer)
    }
  }

  // onPeers handle peer list event.
  onPeers (cleardata, data) {
    // console.log("onPeers")
    if (data.from!==this.serverpubkey){
      console.error("must be issued by the server")
      console.error("cleardata", cleardata)
      console.error("data", data)
      return
    }

    this.peers = cleardata.peers;
    this.sharedKeys = []

    const bPub = this.mycrypto.publicKey();
    const shared = this.mesharedcrypto.get();

    this.peers.map((p) => {
      if (p.publicKey===bPub){
        p.handle = this.me.handle;
        p.publicKey = bPub;
        this.me.since = p.since;
        this.sharedKeys.push({from: bPub, key:shared, since: p.since});
        this.trigger(EvType.PeerAccept, JSON.parse(JSON.stringify(p)))
        return
      }
      // this.sharedKeys.push({from: p.publicKey, key:p.shared, since: p.since});
      this.trigger(EvType.PeerConnect, p)
      this.issueChallenge(p.publicKey);
    });
  }

  // issueChallenge sends a challenge to the remote to accept us.
  // The challenge is a hash of the room password, the since server time value,
  // a nonce, and the peer public key.
  issueChallenge(peerPublicKey) {
    const peer = this.peers.filter( this.isPubKey(peerPublicKey) ).pop()
    if (!peer) {
      return
    }
    const nego = this.newToken(peer.publicKey);
    const bPub = this.mycrypto.publicKey();
    const hnonce = this.mycrypto.newNonce();
    const hash = this.mycrypto.hashRoomPwd(this.me.password, peer.since, hnonce, bPub, peer.publicKey);
    var sealedauth = "";
    if (this.me.sealedauths && this.me.sealedauths[peer.publicKey]) {
      sealedauth = this.me.sealedauths[peer.publicKey];
      delete(this.me.sealedauths[peer.publicKey])
    }
    const data = {
      type: MsgType.ChallengeQuery,
      data: hash,
      nonce: hnonce,
      handle: this.me.handle,
      sealedauth: sealedauth,
      token: nego.token,
    }
    this.send(data, peer.publicKey);
  }

  // onChallengeQuery handles challenge sent by other peers,
  // it issue an accept message on success,
  // a duplicate handle message if the handles is busy.
  // The challenge consist of recrate the hash with our data,
  // and compare it to the received challenge hash.
  // If the challenge is completed,
  // then the peer handle is checked for duplication.
  // If it is uniq an accept message is issued.
  // Otherwise a duplicate handle message is issued.
  // It saves the peer handle to the peer list.
  onChallengeQuery(cleardata, data) {
    var peer = this.peers.filter( this.isPubKey(data.from) ).shift();
    if (!peer) {
      console.error("invalid challenge: peer not found");
      this.issueChallengeResponse(peer.publicKey, cleardata.token, ChResults.PeerNotFound);
      return
    }
    const isRenewHandle = this.isPeerStatus(peer.publicKey, ChResults.OK);
    const bpub = this.mycrypto.publicKey()
    const hash = this.mycrypto.hashRoomPwd(this.me.password, this.me.since, cleardata.nonce, data.from, bpub);
    if(hash!==cleardata.data) {
      console.error("invalid challenge: hash mismatch");
      this.issueChallengeResponse(peer.publicKey, cleardata.token, ChResults.InvalidHash);
      return
    }

    peer.passSealedAuth = false;
    if (cleardata.sealedauth) {
      var nonce = cleardata.sealedauth.nonce;
      var data = cleardata.sealedauth.data;
      var sealedAuth = this.mycrypto.decrypt(data, nonce, this.serverpubkey)
      if (!sealedAuth) {
        console.error("invalid challenge: sealed auth can not be decrypted");
        this.issueChallengeResponse(peer.publicKey, cleardata.token, ChResults.InvalidSealedAuth);
        return
      }
      if(sealedAuth.secret!==this.me.secret){
        console.error("invalid challenge: invalid secret"); // this is probably very bad.
        this.issueChallengeResponse(peer.publicKey, cleardata.token, ChResults.InvalidSealedAuth);
        return
      }
      var maxElapsed = 60 * 5; //5 minutes
      if (this.isBefore(sealedAuth.date, maxElapsed)) {
        console.error("invalid challenge: token lifetime exceeded");
        this.issueChallengeResponse(peer.publicKey, cleardata.token, ChResults.InvalidSealedAuth);
        return
      }
      peer.passSealedAuth = true;
    }

    var peerValidHandle = true;

    const bPub = this.mycrypto.publicKey();
    const conflictPeerHandle = this.peers.filter( this.notPubKey(peer.publicKey) )
      .filter( this.isHandle(cleardata.handle) ).shift();

    if (conflictPeerHandle) {

      var conflictpeerValidHandle = true;

      if (peer.passSealedAuth && conflictPeerHandle.passSealedAuth) {
        peerValidHandle = peer.since<conflictPeerHandle.since;
        conflictpeerValidHandle = conflictPeerHandle.since<peer.since;

      } else if (peer.passSealedAuth && !conflictPeerHandle.passSealedAuth) {
        conflictpeerValidHandle = false;
        peerValidHandle = true;

      } else if (!peer.passSealedAuth && conflictPeerHandle.passSealedAuth) {
        conflictpeerValidHandle = true;
        peerValidHandle = false;

      }else{
        peerValidHandle = peer.since<conflictPeerHandle.since;
        conflictpeerValidHandle = conflictPeerHandle.since<peer.since;
      }

      if (!conflictpeerValidHandle) {
        this.issueInvalidPeerHandle(conflictPeerHandle, cleardata.token, conflictPeerHandle.handle)
      }
    }

    if (!peerValidHandle) {
      this.issueInvalidPeerHandle(peer, cleardata.token, cleardata.handle)
      return
    }

    const oldHandle = peer.handle;
    peer.handle = cleardata.handle;
    this.issueChallengeResponse(
      peer.publicKey,
      cleardata.token,
      ChResults.OK,
      {shared: this.mesharedcrypto.get()},
    );

    if (isRenewHandle && oldHandle!==peer.handle) {
      this.trigger(EvType.PeerRenewHandle, peer, oldHandle)
    }
  }

  issueInvalidPeerHandle(peer, token, oldHandle) {
    const bPub = this.mycrypto.publicKey();
    if (peer.publicKey==bPub) {
      this.renewHandle()
      return
    }
    this.issueChallengeResponse(
      peer.publicKey,
      token,
      ChResults.DuplicateHandle,
      {handle: oldHandle}
    );
  }

  // issueChallengeResponse sends a chalenge failure message.
  issueChallengeResponse(peerPublicKey, token, result, opts) {
    console.log("issueChallengeResponse", peerPublicKey)
    if ( this.isPeerStatus(peerPublicKey, ChResults.OK) ) {
      const peer = this.peers.filter( this.isPubKey(peerPublicKey) ).shift();
      if (peer){
        this.trigger(EvType.PeerLeave, peer)
      }
    }
    this.setPeerStatus(peerPublicKey, result)
    const bPub = this.mycrypto.publicKey();
    var data = opts || {}
    data.type = MsgType.ChallengeResponse
    data.token = token
    data.result = result
    this.send(data, peerPublicKey);
  }

  // issueChallengeResponse sends a chalenge failure message.
  onChallengeResponse(cleardata, data) {
    console.log("onChallengeResponse", data.from)
    const nego = this.validateToken(data.from, cleardata.token, cleardata.result)
    if (!nego) {
      console.log("onChallengeResponse: invalid token", data.token, " wanted ",nego.token)
      return
    }
    this.trigger(EvType.Negotiating, this.cntNegotiations())

    const remote = this.peers.filter( this.isPubKey(data.from) ).shift();
    if (!remote){
      console.log("onChallengeResponse: remote peer not found", data.from)
      return
    }

    if (cleardata.result===ChResults.OK){
      this.sharedKeys = this.sharedKeys.filter( this.notFrom(remote.publicKey) )
      this.sharedKeys.push({from: remote.publicKey, key: cleardata.shared, since: remote.since});
      this.setPeerStatus(remote.publicKey, ChResults.OK)
      this.trigger(EvType.PeerAccept, JSON.parse(JSON.stringify(remote)))

    } else{
      if ( this.isPeerStatus(remote.publicKey, ChResults.OK) ) {
        this.trigger(EvType.PeerLeave, remote)
      }
      this.setPeerStatus(remote.publicKey, cleardata.result)
    }

    const acceptedPeers = this.peers.filter( this.iAccepted.bind(this) );
    const majority = acceptedPeers.length/2;
    if (majority<1) {
      return
    }

    var invalidHash = this.cntPeerStatus(ChResults.InvalidHash);
    var invalidSealedAuth = this.cntPeerStatus(ChResults.InvalidSealedAuth);
    var handleKo = this.cntPeerStatus(ChResults.DuplicateHandle);
    var totalOk = this.cntPeerStatus(ChResults.OK);
    const totalKo = invalidHash + invalidSealedAuth + handleKo;

    if (handleKo>=majority || invalidSealedAuth>=majority) {
      this.renewHandle()
      return
    }else if (totalKo>=majority) {
      this.trigger(EvType.Error, "You were not accepted to the room");
      return
    }
    this.trigger(EvType.Accept);
  }

  //renewHandle renews and handle whecking its uniquness
  // according to our current peer list.
  // It then triggers a challenge sequence to become accepted.
  renewHandle() {
    var newHandle = "";
    const validPeers = this.peers.filter(this.iAccepted);
    if (validPeers.length>0){
      var uniq = false;
      while(!uniq) {
        newHandle = makeid(5);
        var k = validPeers.filter(this.isHandle(newHandle))
        uniq = k.length===0;
      }
    }
    this.changeHandle(newHandle)
  }

  // changeHandle handles the handle renewing,
  // it verifies that the new handle is uniq, or
  // shows a notficiation error.
  // It then re challenge each peer with the new handle.
  changeHandle(newHandle) {
    if (newHandle===this.me.handle) {
      return
    }
    var uniq = false;
    const validPeers = this.peers.filter(this.iAccepted);
    var k = validPeers.filter(this.isHandle(newHandle))
    uniq = k.length===0;
    if(!uniq){
      this.trigger(EvType.Error, "Your handle is already taken by another peer, change your nickname");
      return false
    }
    this.trigger(EvType.RenewMyHandle, newHandle)
    const bPub = this.mycrypto.publicKey();
    this.me.handle = newHandle;
    this.peers.filter( this.isPubKey(bPub) ).map( (p) => {
      p.handle = newHandle;
    })
    this.peers.filter( this.notPubKey(bPub) ).map( (p) => {
      this.issueChallenge(p.publicKey)
    })
    return true
  }

  elapsed(since){
    var elapsed = Date.UTC() - Date.parse(since);
    var elapsedSec = Math.round(elapsed/1000);
    return elapsedSec
  }
  isBefore(date, maxSec){
    var elapsed = this.elapsed(date)
    return elapsed > maxSec
  }
  iAccepted(){
    return (p) => {
      return this.isPeerStatus(p.publicKey, ChResults.OK)
    }
  }
  withKey(publicKey){
    return (k) => {
      return !!k.key;
    }
  }
  isSharedPubkey(publicKey){
    return (k) => {
      return k.key && k.key.publicKey===publicKey
    }
  }
  notFrom(pubKey){
    return (p) => {
      return p.from!==pubKey;
    }
  }
  isFrom(pubKey){
    return (p) => {
      return p.from===pubKey;
    }
  }
  notPubKey(pubKey){
    return (p) => {
      return p.publicKey!==pubKey;
    }
  }
  isPubKey(pubKey){
    return (p) => {
      return p.publicKey===pubKey;
    }
  }
  isHandle(handle){
    return (p) => {
      return p.handle===handle;
    }
  }
  sortBySince(a, b) {
      const aSince = Date.parse(a.since)
      const bSince = Date.parse(a.since)
      if (aSince < bSince) {
        return -1;
      } else if (aSince > bSince) {
        return 1;
      }
      return 0;
  }
  sortByHandle(a, b) {
    if (a.handle < b.handle) {
        return -1;
    } else if (a.handle > b.handle) {
        return 1;
    }
    return 0;
  }
}
