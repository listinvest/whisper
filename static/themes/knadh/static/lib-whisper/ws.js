
const ErrSocketClosed = "socket is closed"

var EvType = EvType || {};
EvType.Connect = "connect";
EvType.Disconnect = "disconnect";
EvType.Message = "message";
EvType.Error = "error";
EvType.Reconnecting = "reconnecting";
EvType.Reconnect = "reconnect";

class WsTransport {
  constructor (reconnectTimeout) {
    this.events = new EventEmitter();
    this.reconnectTimeout = reconnectTimeout;
    this.reconnectHandle = null;
    this.url = null;
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


  // connect the websocket.
  connect (url) {
    if (this.ws!=null){
      this.close();
    }
		// var url = document.location.protocol.replace(/http(s?):/, "ws$1:") +
		// 	document.location.host + "/r/" + roomID + "/ws";
    this.url = url;
    this.ws = new WebSocket(url);

    var that = this;
    this.ws.onopen = () => {
      that.trigger("connect");
    };
    this.ws.onmessage = (m) => {
      that.trigger(EvType.Message, m.data);
    };
    this.ws.onerror = (e) => {
      that.trigger("error", e);
      that.ws.close();
      that.ws = null;
    };
    this.ws.onclose = (e) => {
      if (e.code == 1000) {
        if (e.reason && MsgType.hasOwnProperty(e.reason)) {
          that.trigger("disconnect", e.reason);
          return
        }
        that.trigger(EvType.Disconnect);
      } else if (e.code != 1005) {
        that.trigger(EvType.Disconnect);
        if (that.reconnectTimeout>0){
          that.trigger(EvType.Reconnecting, that.reconnectTimeout);
          clearTimeout(that.reconnectHandle)
          that.reconnectHandle = setTimeout(that.reconnect.bind(this), that.reconnectTimeout);
        }
      }
    };
    // -
  };

  // send a message
  send (msg) {
		if (!this.ws || this.ws.readyState == WebSocket.CLOSED || this.ws.readyState == WebSocket.CLOSING)
      return ErrSocketClosed;

		try {
			if (typeof (msg) == "object") {
				msg = JSON.stringify(msg);
			}
			this.ws.send(msg);
		} catch (e) {
      return e
		};
    return null;
  }

  reconnect () {
    clearTimeout(this.reconnectHandle);
    this.trigger(EvType.Reconnect, this.reconnectTimeout);
		this.connect(this.url);
  }

  close () {
    this.ws.close();
    this.url = null;
  }
}
