var Client = new function () {
	const MsgType = {
		"connect": "connect",
		"disconnect": "disconnect",
		"reconnecting": "reconnecting",
		"room.dispose": "room.dispose",
		"room.full": "room.full",
		"message": "message",
		"uploading": "uploading",
		"upload": "upload",
		"typing": "typing",
		"peer.list": "peer.list",
		"peer.info": "peer.info",
		"peer.join": "peer.join",
		"peer.leave": "peer.leave",
		"peer.ratelimited": "peer.ratelimited",
		"peer.renewhandle": "peer.renewhandle",
		"notice": "notice",
		"handle": "handle",
		"growl": "growl",
		"ping": "ping",
		"whisper": "whisper",
		"motd": "motd",
		"help": "help",
		"crypted.message": "crypted.message",
		"challenge.query": "challenge.query",
		"challenge.failed": "challenge.failed",
		"duplicate.handle": "duplicate.handle",
		"invalid.sealedauth": "invalid.sealedauth"
	};
	this.MsgType = MsgType;

	var wsURL = null,
		pingInterval = 5, // seconds
		reconnectInterval = 4000;

	var ws = null,
		// event hooks
		triggers = {},
		keys = {},
		ping_timer = null,
		reconnect_timer = null,
		peer = { id: null, handle: null },
		mycrypto = window.cryptoutil();


	// Initialize and connect the websocket.
	this.init = function (roomID, myKeys) {
		wsURL = document.location.protocol.replace(/http(s?):/, "ws$1:") +
			document.location.host + "/r/" + roomID + "/ws";
		mycrypto.set(myKeys)
	};

	// Peer identification info.
	this.peer = function () {
		return peer;
	}

	// websocket hooks
	this.connect = function () {
		ws = new WebSocket(wsURL);
		ws.onopen = function () {
			trigger(MsgType["connect"]);
		};

		ws.onmessage = function (e) {
			var data = {};
			try {
				data = JSON.parse(e.data);
			} catch (e) {
				return null;
			}
			// trigger(data.type, data);
			mapMessage(data);
		};

		ws.onerror = function (e) {
			ws.close();
			ws = null;
		};

		ws.onclose = function (e) {
			if (e.code == 1000) {
				if (e.reason && MsgType.hasOwnProperty(e.reason)) {
					trigger(e.reason);
					return
				}
				trigger(MsgType["disconnect"]);
			} else if (e.code != 1005) {
				trigger(MsgType["disconnect"]);
				attemptReconnection();
			}
		};
	};

	// register callbacks
	this.on = function (typ, callback) {
		if (!triggers.hasOwnProperty(typ)) {
			triggers[typ] = [];
		}
		triggers[typ].push(callback);
	};

	this.addKey = function (key) {
		keys[key.publicKey] = key
	};

	this.rmKey = function (key) {
		delete(keys[key.publicKey])
	};

	// fetch peers list
	this.getPeers = function () {
		this.send({ "type": MsgType["peer.list"] });
	};

	// send a message
	this.send = function (msg, b64ToPubKey) {
		const nonce = mycrypto.newNonce();
		const data = mycrypto.encrypt(JSON.stringify(msg), nonce, b64ToPubKey);
		const bPub = mycrypto.publicKey();
		send({ "data": data, "nonce": nonce, "from": bPub, "to": b64ToPubKey });
	}

	// broadcast a message
	this.broadcast = function (msg, b64ToPubKey, asKey) {
		const nonce = mycrypto.newNonce();
		const bPub = mycrypto.publicKey();
		var crypto = window.cryptoutil();
		crypto.set(asKey);
		const data = mycrypto.encrypt(JSON.stringify(msg), nonce, crypto.publicKey());
		send({ "data": data, "nonce": nonce, "from": bPub, "to": asKey.publicKey });
	}

	// ___ private
	// send a message via the socket
	// automatically encodes json if possible
	function send(message, json) {
		if (!ws || ws.readyState == ws.CLOSED || ws.readyState == ws.CLOSING) return;

		try {
			if (typeof (message) == "object") {
				message = JSON.stringify(message);
			}
			ws.send(message);
		} catch (e) {
			console.log("error: " + e);
		};
	}

	// trigger event callbacks
	function trigger(typ, cleardata, data) {
		if (!triggers.hasOwnProperty(typ)) {
			return;
		}

		for (var n = 0; n < triggers[typ].length; n++) {
			triggers[typ][n].call(triggers[typ][n], cleardata, data);
		}
	}
	function mapMessage(msg) {
		var foundkey=null;
		if (msg.to === mycrypto.publicKey()){
			foundkey = mycrypto.get()
		}else if (keys[msg.to]) {
			foundkey = keys[msg.to]
		}else {
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
		const cleardata = JSON.parse(nacl.util.encodeUTF8(scleardata));
		trigger(cleardata.type, cleardata, msg);
	}

	function attemptReconnection() {
		trigger(MsgType["reconnecting"], reconnectInterval);
		// reconnect_timer = setTimeout(function () {
		// 	reconnect_timer = null;
		// 	self.connect();
		// }, reconnectInterval);
	}

	var self = this;
};
