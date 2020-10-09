const linkifyExpr = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
const notifType = {
    notice: "notice",
    error: "error"
};
const typingDebounceInterval = 3000;

Vue.component("expand-link", {
    props: ["link"],
    data: function () {
        return {
            visible: false
        }
    },
    methods: {
        select(e) {
            e.target.select();
        }
    },
    template: `
        <div class="expand-link">
            <a href="#" v-on:click.prevent="visible = !visible">🔗</a>
            <input v-if="visible" v-on:click="select" readonly type="text" :value="link" />
        </div>
    `
});

var commands = {
  "handle": {
    "help": "Change your handle",
    "usage": "/handle [new username]",
  },
  "growl": {
    "help": "Send a growl notification to an user",
    "usage": "/growl [user] [message]",
  },
  "ping": {
    "help": "Send a ping notification to an user",
    "usage": "/ping [user] [message]",
  },
  "whisper": {
    "help": "Send a message to a specific user",
    "usage": "/whisper [user] [message]",
  },
  "help": {
    "help": "Show commands help",
    "usage": "/help [command]?",
  },
  "debug": {
    "help": "Print debug data",
    "usage": "/debug",
  },
}

// throw it at startup, though you will need an ssl certificate.
Notify.requestPermission(null, null);
var converter = new showdown.Converter();

function makeid(length) {
   var result           = '';
   var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
   var charactersLength = characters.length;
   for ( var i = 0; i < length; i++ ) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
   }
   return result;
}

function sortByHandle(a, b) {
  if (a.handle < b.handle) {
      return -1;
  } else if (a.handle > b.handle) {
      return 1;
  }
  return 0;
}

var MsgType = MsgType || {};
MsgType.Motd = "motd";
MsgType.Error = "error";
MsgType.Help = "help";
MsgType.Uploading = "uploading";
MsgType.Upload = "upload";
MsgType.PeerRenewHandle = EvType.PeerRenewHandle;
MsgType.Whisper = "whisper";
MsgType.Ping = "ping";
MsgType.Typing = "typing";
MsgType.RateLimited = "peer.ratelimited";
MsgType.RoomFull = "room.full";
MsgType.RoomDispose = "room.dispose";

var app = new Vue({
    el: "#app",
    delimiters: ["{(", ")}"],
    data: {
        isBusy: false,
        chatOn: false,
        sidebarOn: true,
        disposed: false,
        hasSound: true,

        // Global flash / notifcation properties.
        notifTimer: null,
        notifMessage: "",
        notifType: "",

        // New activity animation in title bar. Page title is cached on load
        // to use in the animation.
        newActivity: false,
        newActivityCounter: 0,
        pageTitle: document.title,

        typingTimer: null,
        typingPeers: new Map(),

        // Form fields.
        roomName: "",
        handle: "",
        password: "",
        message: "",

        // Chat data.
        serverpubkey: "",
        self: {},
        whisper: {},
        transport: {},

        messages: [],
        peers: [],

        // upload
        isDraggingOver: false,

        negotiating: 0,
    },
    created: function () {
        // this.initClient();
        this.initTimers();

        this.whisper = new Whisper()
        this.transport = new WsTransport(0)
        this.transport.on(EvType.Connect, this.onTransportConnect.bind(this))
        this.transport.on(EvType.Disconnect, this.onTransportDisconnect.bind(this))

        this.whisper.on(EvType.Negotiating, this.onNegotiating.bind(this));
        // this.whisper.on("handle.renew", this.onNegotiating.bind(this));
        // this.whisper.on("peer.renewhandle", this.onPeerRenewHanle.bind(this));
        this.whisper.on(EvType.PeerRenewHandle, this.onPeerRenewHandle.bind(this));
        this.whisper.on(EvType.RenewMyHandle, this.onRenewMyHandle.bind(this));
        this.whisper.on(EvType.PeerAccept, this.onPeerAccept.bind(this));
        this.whisper.on(EvType.PeerLeave, this.onPeerLeave.bind(this));
        this.whisper.on(EvType.Message, this.onMessage.bind(this));
        this.whisper.on(MsgType.Typing, this.onTyping.bind(this));
        this.whisper.on(MsgType.Ping, this.onPing.bind(this));
        this.whisper.on(MsgType.Whisper, this.onWhisper.bind(this));
        //
        var url = new URL(document.location.href);
        var al = url.searchParams.get("al");
        al && this.handleLogin();
    },
    computed: {
    },
    methods: {

        // Handle room creation.
        handleCreateRoom() {
            fetch("/api/rooms", {
                method: "post",
                body: JSON.stringify({
                    name: this.roomName,
                    password: this.password
                }),
                headers: { "Content-Type": "application/json; charset=utf-8" }
            })
            .then(resp => resp.json())
            .then(resp => {
                this.toggleBusy();
                this.clearCreateRoom();
                if (resp.error) {
                    this.notify(resp.error, notifType.error);
                } else {
                    document.location.replace("/r/" + resp.data.id);
                }
            })
            .catch(err => {
                this.toggleBusy();
                this.notify(err, notifType.error);
            });
        },

        clearCreateRoom() {
          this.roomName = "";
          this.password = "";
        },

        // Login to a room.
        handleLogin() {
          const bpub = this.whisper.mycrypto.publicKey();
          var password = this.password || this.self.password || "";
          var handle = this.self.handle || this.handle;
          if (!handle) {
            handle = makeid(5);
          }
          handle = handle.replace(/[^a-z0-9_\-\.@]/ig, "");

          var url = new URL(document.location.href);
          var al = url.searchParams.get("al");
          var fetchURL = "/r/" + _room.id + "/login"
          if (al) {
            fetchURL = "/r/" + _room.id + "/login?al="+al
          }

          this.notify("Logging in", notifType.notice);
          fetch(fetchURL, {
              method: "post",
              body: JSON.stringify({
                publickey: bpub,
              }),
              headers: { "Content-Type": "application/json; charset=utf-8" }
          })
          .then(resp => resp.json())
          .then(resp => {
              if (resp.error) {
                  this.notify(resp.error, notifType.error);
                  if (al){ // remote the GET al argument from the window url.
                    window.history.pushState({},document.title, "/r/" + _room.id);
                  }
                  return;
              }
              this.chatOn = true;
              this.isRequesting = false;
              this.clearLogin();
              this.deNotify();
              this.self.handle = handle;
              this.self.since = resp.data.since;
              this.self.secret = resp.data.secret;
              if (al && resp.data.Handle!="") {
                this.self.handle = resp.data.handle;
                this.self.sealedauths = resp.data.sealedauths || {};
              }
              this.self.password = password;
              this.serverpubkey = resp.data.serverpubkey;
              this.whisper.connect (this.transport, this.serverpubkey, this.self);
              this.transport.connect(this.transportURL());
              setTimeout(this.onResize, 100)
          })
          .catch(err => {
              this.isRequesting = false;
              this.notify(err, notifType.error);
          });
        },

        clearLogin() {
          this.handle = "";
          this.password = "";
        },

        transportURL() {
          var url = document.location.protocol.replace(/http(s?):/, "ws$1:") + "//"+
            document.location.host + "/r/" + _room.id + "/ws";
          return url;
        },

        onTransportConnect() {
          clearTimeout(this.reconnectHandle)
        },

        onTransportDisconnect() {
          this.whisper.close()
          this.onTransportReconnecting(4000)
        },

        onTransportReconnecting(timeout) {
          this.notify("Disconnected. Trying to connect...", notifType.notice, timeout);
          clearTimeout(this.reconnectHandle)
          this.reconnectHandle = setTimeout(function () {
            clearTimeout(this.reconnectHandle)
            this.notify("Logging in", notifType.notice);

            const bpub = this.whisper.mycrypto.publicKey();
            this.isRequesting = true;
            this.chatOn = true;
            var fetchURL = "/r/" + _room.id + "/login"
            fetch(fetchURL, {
              method: "post",
              body: JSON.stringify({
                publickey: bpub,
                secret: this.self.secret,
              }),
              headers: { "Content-Type": "application/json; charset=utf-8" }
            })
            .then(resp => resp.json())
            .then(resp => {
              if (resp.error) {
                this.notify(resp.error, notifType.error);
                this.reconnectHandle = setTimeout(function () {
                  this.onTransportReconnecting(timeout)
                }.bind(this), timeout/2);
                return;
              }
              this.self.avatar = this.hashColor(bpub);
              this.self.since = resp.data.since;
              this.self.secret = resp.data.secret;
              this.self.sealedauths = resp.data.sealedauths;
              this.serverpubkey = resp.data.serverpubkey;

              this.chatOn = true;
              this.isRequesting = false;
              this.deNotify();
              this.whisper.connect (this.transport, this.serverpubkey, this.self);
              this.transport.connect(this.transportURL());
            })
            .catch(err => {
              this.isRequesting = false;
              this.notify(err, notifType.error);
              this.reconnectHandle = setTimeout(function () {
                this.onTransportReconnecting(timeout)
              }.bind(this), timeout/2);
            });

          }.bind(this), timeout);
        },

        onDisconnect(typ) {
          // this.whisper.close()
          // Client.clearKeys()
          // this.connectStatus = {};
          switch (typ) {
              case MsgType.Disconnect:
                  this.notify("Disconnected. Retrying ...", notifType.notice);
                  break;

              case MsgType.RateLimited:
                  this.notify("You sent too many messages", notifType.error);
                  this.toggleChat();
                  break;

              case MsgType.RoomFull:
                  this.notify("Room is full", notifType.error);
                  this.toggleChat();
                  break;

              case MsgType.RoomDispose:
                  this.notify("Room disposed", notifType.error);
                  this.toggleChat();
                  this.disposed = true;
                  break;
          }
          // window.location.reload();
        },

        // Capture keypresses to send message on Enter key and to broadcast
        // "typing" statuses.
        handleChatKeyPress(e) {
            if (e.keyCode == 13 && !e.shiftKey) {
                e.preventDefault();
                this.handleSendMessage();
                return;
            }

            // If it's a non "text" key, ignore.
            if (!String.fromCharCode(e.keyCode).match(/(\w|\s)/g)) {
                return;
            }

            // Debounce and wait for N seconds before sending a typing status.
            if (this.typingTimer) {
                return;
            }

            const data = {
              type: MsgType.Typing,
              publicKey: this.whisper.mycrypto.publicKey(),
            }
            this.whisper.broadcast(data)

            this.typingTimer = window.setTimeout(() => {
                this.typingTimer = null;
            }, typingDebounceInterval);
        },

        handleSendMessage() {
          window.clearTimeout(this.typingTimer);
          this.typingTimer = null;

          var userMsg = this.message.trim();
          if (userMsg.length<1) {
            return
          }
          this.message = "";
          var re = new RegExp("^/(\\S+)");
          var m = userMsg.match(re);
          if (!m) {
            const data = {
              type: MsgType.Message,
              data: userMsg,
              timestamp: new Date(),
            }
            this.whisper.broadcast(data)
            return
          }

          var commandName = m[1];
          if (!(commandName in commands)) {
              this.messages.push({
                  type: MsgType.Error,
                  message: `command not found /${commandName}`
              });
              this.scrollToNewester();
              return
          }

          const command = commands[commandName]
          if (commandName=="help"){
            this.handleShowHelp(userMsg, commandName, command)

          }else if (commandName=="handle"){
            this.handleSetHandle(userMsg, commandName, command)

          }else if (commandName=="debug"){
            this.handleDebug(userMsg, commandName, command)

          }else if (commandName=="growl"){
            this.handleGrowl(userMsg, commandName, command)

          }else if (commandName=="ping"){
            this.handlePing(userMsg, commandName, command)

          }else if (commandName=="whisper"){
            this.handleWhisper(userMsg, commandName, command)
          }
        },

        handleDebug(userMsg, commandName, command) {
          console.log("self: ", this.self)
          console.log("handle: ", this.handle)
          console.log("password: ", this.password)
          console.log("mycrypto: ", this.whisper.mycrypto.get())
          console.log("mesharedcrypto: ", this.mesharedcrypto.get())
          console.log("peers: ", this.peers)
          console.log("connectStatus: ", this.connectStatus)
        },

        handleShowHelp(userMsg, commandName, command) {
          var message = "";
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)");
          var matches = userMsg.match(re);
          if (matches) {
            var key = matches[2]
            message += `<b>/${key}</b>: ${command.help}<br/>`
            message += `Usage ${command.usage}<br/>`
          } else{
            message += "<b>Help for all commands</b><br/>"
            Object.keys(commands).map((key)=>{
              const command = commands[key]
              message += "<br/>"
              message += `<b>/${key}</b>: ${command.help}<br/>`
              message += `Usage ${command.usage}<br/>`
            });
          }
          this.messages.push({
              type: MsgType.Help,
              message: message
          });
          this.scrollToNewester();
        },

        handleSetHandle(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)");
          var matches = userMsg.match(re);
          this.whisper.changeHandle(matches[2])
        },

        handlePing(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)\\s+(.*)");
          var matches = userMsg.match(re);
          const peer = this.peers.filter( this.whisper.isHandle(matches[2]) ).shift()
          if (!peer) {
            return
          }
          const data = {
            type: MsgType.Ping,
            data: matches[3],
          }
          this.whisper.send(data, peer.publicKey)
        },

        handleWhisper(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)\\s+(.*)");
          var matches = userMsg.match(re);
          const peer = this.peers.filter( this.whisper.isHandle(matches[2]) ).shift()
          if (!peer) {
            return
          }
          const data = {
            type: MsgType.Whisper,
            data: matches[3],
          }
          this.whisper.send(data, peer.publicKey)
        },

        handleGrowl(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)\\s+(.*)");
          var matches = userMsg.match(re);
          const data = {
            type: MsgType.Growl,
            data: {
              to: matches[2],
              from: this.self.handle,
              msg: matches[3],
            },
          }
          this.whisper.send(data, this.serverpubkey)
        },

        handleLogout() {
            if (!confirm("Logout?")) {
                return;
            }
            this.whisper.close();
            fetch("/r/" + _room.id + "/login", {
                method: "delete",
                headers: { "Content-Type": "application/json; charset=utf-8" }
            })
            .then(resp => resp.json())
            .then(resp => {
                this.toggleChat();
                document.location.reload();
            })
            .catch(err => {
                this.notify(err, notifType.error);
            });
        },

        handleDisposeRoom() {
            if (!confirm("Disconnect all peers and destroy this room?")) {
                return;
            }
            const data = {
              type: MsgType.RoomDispose,
            }
            this.whisper.sendMessage(data, this.serverpubkey);
        },

        // Flash notification.
        notify(msg, typ, timeout) {
            clearTimeout(this.notifTimer);
            this.notifTimer = setTimeout(function () {
                this.notifMessage = "";
                this.notifType = "";
            }.bind(this), timeout ? timeout : 3000);

            this.notifMessage = msg;
            if (typ) {
                this.notifType = typ;
            }
        },

        beep() {
            const b = document.querySelector("#beep");
            b.pause();
            b.load();
            b.play().catch((e)=>{});
        },

        deNotify() {
            clearTimeout(this.notifTimer);
            this.notifMessage = "";
            this.notifType = "";
        },

        hashColor(str) {
            for (var i = 0, hash = 0; i < str.length; hash = str.charCodeAt(i++) + ((hash << 5) - hash));
            for (var i = 0, colour = "#"; i < 3; colour += ("00" + ((hash >> i++ * 8) & 0xFF).toString(16)).slice(-2));
            return colour;
        },

        formatDate(ts) {
            var t = null
            if (ts instanceof Date) {
              t = ts
            }else {
              t = new Date(ts)

            }
            var h = t.getHours(),
                minutes = t.getMinutes(),
                hours = ((h + 11) % 12 + 1);
            return (hours < 10 ? "0" : "")
                + hours.toString()
                + ":"
                + (minutes < 10 ? "0" : "")
                + minutes.toString()
                + " " + (h > 12 ? "PM" : "AM");
        },

        formatMessage(text) {
            const div = document.createElement("div");
            div.appendChild(document.createTextNode(text));
            var html = div.innerHTML;
            var links = html.match(linkifyExpr)
            links && links.map((l)=>{
              var match = null;
              // lookup for some video integration.
              //https://www.youtube.com/watch?v=kgQEvTujCoE
              var ytb = new RegExp("^(http|https)?://([^/]+)youtube([^/]+)/watch?.*v=([^&]+)[^\\s]*","gi")
              match = html.match(ytb)
              if (match) {
                ytb = new RegExp("^(http|https)?://([^/]+)youtube([^/]+)/watch?.*v=([^&]+)[^\\s]*","i")
                match.map((m)=>{
                  var id = "";
                  var captured = m.match(ytb)
                  if (captured) {
                    id = captured[4]
                  }
                  if (id) {
                    html = html.replace(m,
                      `<iframe type="text/html"
                      class="video"
                      webkitallowfullscreen mozallowfullscreen allowfullscreen
                      src="http://www.youtube.com/embed/${id}?enablejsapi=1"
                      ></iframe>`.replace(/\n+/ig," "))
                  }
                })
                return
              }
              //https://www.dailymotion.com/video/x7vzvxe
              var dlm = new RegExp("^(http|https)?://([^/]+)dailymotion([^/]+)/video/([^?/]+)[^\\s]*","gi")
              match = html.match(dlm)
              if (match) {
                dlm = new RegExp("^(http|https)?://([^/]+)dailymotion([^/]+)/video/([^?/]+)","i")
                match.map((m)=>{
                  var id = "";
                  var captured = m.match(dlm)
                  if (captured) {
                    id = captured[4]
                  }
                  if (id) {
                    html = html.replace(m,
                      `<iframe src="https://www.dailymotion.com/embed/video/${id}"
                        class="video"
                        webkitallowfullscreen mozallowfullscreen allowfullscreen
                        ></iframe>`.replace(/\n+/ig," "))
                  }
                })
                return
              }
              //https://vimeo.com/220643959
              var vmo = new RegExp("^(http|https)?://([^/]*)vimeo([^/]+)/([^?/\\s]+)","gi")
              match = html.match(vmo)
              if (match) {
                vmo = new RegExp("^(http|https)?://([^/]*)vimeo([^/]+)/([^?/\\s]+)","i")
                match.map((m)=>{
                  var id = "";
                  var captured = m.match(vmo)
                  if (captured) {
                    id = captured[4]
                  }
                  if (id) {
                    html = html.replace(m,
                      `<iframe src="//player.vimeo.com/video/${id}?title=0&byline=0"
                        class="video"
                        webkitallowfullscreen mozallowfullscreen allowfullscreen
                        ></iframe>`.replace(/\n+/ig," "))
                  }
                })
                return
              }
              //https://peertube.social/videos/watch/ad395c9b-9702-4060-ac05-4c94b64956ab
              var ptb = new RegExp("^(http|https)?://([^/]*)peertube([^/]+)/videos/watch/([^?/\\s]+)$","gi")
              match = html.match(ptb)
              if (match) {
                ptb = new RegExp("^(http|https)?://([^/]*)peertube([^/]+)/videos/watch/([^?/\\s]+)$","i")
                match.map((m)=>{
                  var id = "";
                  var sdns = "";
                  var captured = m.match(ptb)
                  if (captured) {
                    sdns = captured[3]
                    id = captured[4]
                  }
                  if (id && sdns) {
                    html = html.replace(m,
                      `<iframe src="https://peertube${sdns}/videos/embed/${id}"
                        class="video"
                        sandbox="allow-same-origin allow-scripts"
                        webkitallowfullscreen mozallowfullscreen allowfullscreen
                        ></iframe>`.replace(/\n+/ig," "))
                  }
                })
                return
              }
              // otherwise it is a regular link
              html = html.replace(l, `<a refl='noopener noreferrer' href='${l}' target='_blank'>${l}</a>`)
            })
            return converter.makeHtml(html)
            // return html.replace(/\n+/ig, "<br />");
        },

        scrollToNewester() {
            this.$nextTick().then(function () {
              if (this.$refs["messages"]) {
                var el = this.$refs["messages"].querySelector(".message:last-child")
                if (el) {
                  el.scrollIntoView();
                }
              }
            }.bind(this));
        },

        // Toggle busy (form button) state.
        toggleBusy() {
            this.isRequesting = !this.isRequesting;
        },

        toggleSidebar() {
            this.sidebarOn = !this.sidebarOn;
        },

        toggleChat() {
            this.chatOn = !this.chatOn;

            this.$nextTick().then(function () {
                if (!this.chatOn && this.$refs["form-password"]) {
                    this.$refs["form-password"].focus();
                    return
                }
                if (this.$refs["form-message"]) {
                    this.$refs["form-message"].focus();
                    this.onResize();
                }
            }.bind(this));
        },

        onNegotiating(negotiating) {
          this.negotiating = negotiating;
        },

        onPeerRenewHandle(peer, oldHandle) {
          var c = this.peers.filter( this.whisper.isPubKey(peer.publicKey) ).shift()
          c.handle = peer.handle
          this.messages.push({
              oldHandle: oldHandle,
              type: MsgType.PeerRenewHandle,
              peer: JSON.parse(JSON.stringify(peer)),
              timestamp: new Date()
          });
          this.scrollToNewester();
        },

        onRenewMyHandle(newHandle) {
          const bPub = this.whisper.mycrypto.publicKey()
          var peer = this.peers.filter( this.whisper.isPubKey(bPub) ).shift()
          var oldHandle = peer.handle;
          peer.handle = newHandle
          this.messages.push({
              oldHandle: oldHandle,
              type: MsgType.PeerRenewHandle,
              peer: JSON.parse(JSON.stringify(peer)),
              timestamp: new Date()
          });
          this.scrollToNewester();
        },

        onPeerAccept(peer) {
          peer = JSON.parse(JSON.stringify(peer));
          const c = this.peers.filter( this.whisper.isPubKey(peer.publicKey) ).shift()
          if (!c) {
            peer.avatar = this.hashColor(peer.publicKey);
            this.peers.push(peer)
            this.peers.sort(sortByHandle)
            this.messages.push({
                type: MsgType.PeerJoin,
                peer: JSON.parse(JSON.stringify(peer)),
                timestamp: new Date()
            });
            this.scrollToNewester();
          }
        },

        onPeerLeave(cleardata, data) {
          // const bPub = this.whisper.mycrypto.publicKey();
          // const peer = cleardata;
          // if (peer.publicKey===bPub){
          //   return
          // }
          const c = this.peers.filter( this.whisper.isPubKey(cleardata.publicKey) ).shift();
          if (c) {
            this.messages.push({
                type: MsgType.PeerLeave,
                peer: JSON.parse(JSON.stringify(c)),
                timestamp: new Date()
            });
            this.scrollToNewester();
            this.peers = this.peers.filter( this.whisper.notPubKey(cleardata.publicKey) )
            this.peers.sort(sortByHandle)
          }
        },

        onPeers(cleardata, data) {
          if (data.from!==this.serverpubkey){
            console.error("must be issued by the server", data, cleardata)
            return
          }

          this.peers = cleardata.peers;

          const bPub = this.mycrypto.publicKey();
          this.peers.forEach((p, i) => {
            p.avatar = this.hashColor(p.publicKey);
            if(p.publicKey!==bPub && (!!p.publicKey) && !p.wasChallenged && !p.passChallenge) {
              p.passChallenge = false;
              p.wasChallenged = true;
              this.issueChallenge(p);
            }else if (p.publicKey===bPub){
              p.handle = this.self.handle;
              p.shared = this.mesharedcrypto.get();
            }
          });

          this.peers.sort(sortByHandle)
        },

        onTyping(cleardata, data) {
            const peer = this.peers.filter( this.whisper.isPubKey(cleardata.publicKey) ).pop();
            if (!peer) {
              console.error("onTyping: peer not found, cleardata=", cleardata)
              return
            }
            this.typingPeers.set(peer.publicKey, {
              publicKey: peer.publicKey,
              handle: peer.handle,
              time: Date.now()
            });
            this.$forceUpdate();
        },

        onMotd(cleardata, data) {
          this.messages.push({
              type: cleardata.type,
              timestamp: new Date(),
              message: cleardata.message
          });
          this.scrollToNewester();
          // If the window isn't in focus, start the "new activity" animation
          // in the title bar.
          if (!document.hasFocus()) {
              this.newActivity = true;
              this.beep();
          }
        },

        onMessage(cleardata, data) {
          const from = data.from;
          const peer = this.peers.filter( this.whisper.isPubKey(from) ).pop();
          if (!peer) {
            console.error("onMessage: peer not found, msg=", data)
            return
          }
          this.typingPeers.delete(from);
          this.messages.push({
              type: cleardata.type,
              timestamp: new Date(),
              message: cleardata.data,
              peer: {
                  handle: peer.handle,
                  avatar: this.hashColor(from)
              }
          });
          this.scrollToNewester();
          // If the window isn't in focus, start the "new activity" animation
          // in the title bar.
          if (!document.hasFocus()) {
              this.newActivity = true;
              this.beep();
          }
        },

        onUpload(cleardata, data) {
        //   var d = data.data.data;
        //   if (data.type==MsgType.Uploading) {
        //     var found = false;
        //     this.messages.map((m) => {
        //       if (m.uid===d.uid){
        //         m.files=d.files;
        //         m.percent=d.percent;
        //         m.type=data.type;
        //         found=true;
        //       }
        //     });
        //     if(!found) {
        //       this.messages.push({
        //         type: data.type,
        //         timestamp: new Date(),
        //         uid: d.uid,
        //         files: d.files,
        //         percent: d.percent,
        //         peer: {
        //           id: data.data.peer_id,
        //           handle: data.data.peer_handle,
        //           avatar: this.hashColor(data.data.peer_id)
        //         }
        //       });
        //     }
        //   }else {
        //     var found = false;
        //     this.messages.map((m) => {
        //       if (m.uid===d.uid){
        //         if(d.res) {
        //           m.res=d.res.data;
        //         }
        //         m.files = m.files || [];
        //         m.err=d.err;
        //         m.type=data.type;
        //         found=true;
        //       }
        //     });
        //     if(!found) {
        //       var res = {};
        //       if (d.res) {
        //         res = d.res.data;
        //       }
        //       this.messages.push({
        //         type: data.type,
        //         timestamp: new Date(),
        //         uid: d.uid,
        //         res: res,
        //         files: [],
        //         err: d.err,
        //         peer: {
        //           id: data.data.peer_id,
        //           handle: data.data.peer_handle,
        //           avatar: this.hashColor(data.data.peer_id)
        //         }
        //       });
        //     }
        //   }
        //   this.scrollToNewester();
        },

        onPing(cleardata, data) {
          if (document.hasFocus()) {
            return
          }
          const peer = this.peers.filter( this.whisper.isPubKey(data.from) ).pop();
          if (!peer) {
            console.error("peer not found", data.from)
            return
          }
          if (Notify.needsPermission) {
            this.messages.push({
              type: MsgType.Ping,
              message: cleardata.data,
              timestamp: new Date(),
              peer: {
                  handle: peer.handle,
                  avatar: this.hashColor(peer.publicKey)
              }
            });
            this.scrollToNewester();
            this.newActivity = true;
            this.beep();
            return
          }
          var title = `${peer.handle} pings you!`;
          new Notify(title, {
            body: msg,
            tag: $.uniqueId(),
            timeout: 4
          }).show();
        },

        onWhisper(cleardata, data) {
          const peer = this.peers.filter( this.whisper.isPubKey(data.from) ).pop();
          if (!peer) {
            console.error("peer not found", data.from)
            return
          }
          this.messages.push({
            type: MsgType.Whisper,
            message: cleardata.data,
            timestamp: new Date(),
            peer: {
                handle: peer.handle,
                avatar: this.hashColor(peer.publicKey)
            }
          });
          this.scrollToNewester();
          if (!document.hasFocus()) {
            this.newActivity = true;
            this.beep();
          }
        },

        initTimers() {
            // Title bar "new activity" animation.
            window.setInterval(() => {
                if (!this.newActivity) {
                    return;
                }
                if (this.newActivityCounter % 2 === 0) {
                    document.title = "[•] " + this.pageTitle;
                } else {
                    document.title = this.pageTitle;
                }
                this.newActivityCounter++;
            }, 2500);
            window.onfocus = () => {
                this.newActivity = false;
                document.title = this.pageTitle;
            };

            // Sweep "typing" statuses at regular intervals.
            window.setInterval(() => {
                let changed = false;
                this.typingPeers.forEach((p, from) => {
                    if ((p.time + typingDebounceInterval) < Date.now()) {
                        this.typingPeers.delete(from);
                        changed = true;
                    }
                });
                if (changed) {
                    this.$forceUpdate();
                }
            }, typingDebounceInterval);
        },

        dragEnter(e) {
          this.isDraggingOver=true
        },

        dragLeave(e) {
          this.isDraggingOver=false
        },

        // image upload
        addFile(e) {
          // this.isDraggingOver=false
          // // based on https://www.raymondcamden.com/2019/08/08/drag-and-drop-file-upload-in-vuejs
          // let droppedFiles = e.dataTransfer.files;
          // if(!droppedFiles) return;
          // var uid = Math.round(new Date().getTime() + (Math.random() * 100));
          // // this tip, convert FileList to array, credit: https://www.smashingmagazine.com/2018/01/drag-drop-file-uploader-vanilla-js/
          // var ok = true;
          // let formData = new FormData();
          // var files = [];
          // ([...droppedFiles]).forEach((f,x) => {
          //   if (x>=20) {
          //     this.notify("Too much files to upload", notifType.error);
          //     ok = false;
          //     return
          //   }
          //   formData.append('file'+(x), f);
          //   files.push(f.name)
          // })
          // if (!ok) {
          //   return
          // }
          // Client.sendMessage(Client.MsgType["uploading"], {uid:uid,files:files,percent:0});
          //
          // axios.post("/r/" + _room.id + "/upload", formData,
          //   {
          //     headers: {
          //         'Content-Type': 'multipart/form-data'
          //     },
          //     onUploadProgress: function( progressEvent ) {
          //       var p = parseInt( Math.round( ( progressEvent.loaded / progressEvent.total ) * 100 ) );
          //       Client.sendMessage(Client.MsgType["uploading"], {uid:uid,files:files,percent:p});
          //     }
          //   }
          // ).then(res => {
          //   if (res.error){
          //     this.notify(res.error, notifType.error);
          //     Client.sendMessage(Client.MsgType["upload"], {uid:uid,err:res.error});
          //   }else{
          //     Client.sendMessage(Client.MsgType["upload"], {uid:uid,res:res.data});
          //   }
          // })
          // .catch(err => {
          //   Client.sendMessage(Client.MsgType["upload"], {uid:uid,err:err.message});
          //   this.notify(err, notifType.error);
          // });
        },

        onResize(event) {
          window.requestAnimationFrame(()=>{
            var header = document.querySelector(".header");
            var style = getComputedStyle(header)
            var headerHeight = parseInt(style.marginTop) + parseInt(style.marginBottom) + header.offsetHeight;
            var fc = document.querySelector(".form-chat")
            var c = document.querySelector(".chat .messages")
            if(fc && c) {
              var vph = window.innerHeight;
              var h = vph-(fc.offsetHeight + headerHeight);
              if (h<0) { h = 0;}
              c.style.height = h + "px";
            }
          });
        }
    },
    mounted() {
      window.addEventListener('resize', this.onResize)
    },
    beforeDestroy() {
      window.removeEventListener('resize', this.onResize)
    }
});
