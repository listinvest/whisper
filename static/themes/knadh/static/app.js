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

function makeid(length) {
   var result           = '';
   var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
   var charactersLength = characters.length;
   for ( var i = 0; i < length; i++ ) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
   }
   return result;
}

function notPubKey(pubKey){
  return (p) => {
    return p.publicKey!==pubKey;
  }
}
function isPubKey(pubKey){
  return (p) => {
    return p.publicKey===pubKey;
  }
}
function sortBySince(a, b) {
    const aSince = Date.parse(a.since)
    const bSince = Date.parse(a.since)
    if (aSince < bSince) {
      return -1;
    } else if (aSince > bSince) {
      return 1;
    }
    return 0;
}
function sortByHandle(a, b) {
  if (a.handle < b.handle) {
      return -1;
  } else if (a.handle > b.handle) {
      return 1;
  }
  return 0;
}

// throw it at startup, though you will need an ssl certificate.
Notify.requestPermission(null, null);

var converter = new showdown.Converter();

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
        userpwd: "",
        message: "",

        // Chat data.
        self: {},
        mycrypto: {}, // my private key to send me private messages
        mesharedcrypto: {}, // shared private key if this peer is "leader"
        messages: [],
        peers: [],

        // upload
        isDraggingOver: false,

        // p2p room connect validations
        connectStatus: {},
        negotiating: 0,
    },
    created: function () {
        this.initClient();
        this.initTimers();
        this.mycrypto = window.cryptoutil();
        this.mesharedcrypto = window.cryptoutil();
        this.mycrypto.init();
        this.mesharedcrypto.init();

        var url = new URL(document.location.href);
        var al = url.searchParams.get("al");
        al && this.handleLogin();
    },
    computed: {
        Client() {
            return window.Client;
        }
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

        // Login to a room.
        handleLogin() {
            // const handle = this.handle.replace(/[^a-z0-9_\-\.@]/ig, "");
            const bpub = this.mycrypto.publicKey();
            var password = this.password || this.self.password || "";
            var handle = this.self.handle || this.handle;
            if (!handle) {
              handle = makeid(5);
            }

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
                    if (al){
                      window.history.pushState({},document.title, "/r/" + _room.id);
                    }
                    return;
                }
                this.chatOn = true;
                this.isRequesting = false;
                this.clear();
                this.deNotify();
                this.self.avatar = this.hashColor(bpub);
                this.self.since = resp.data.since;
                this.self.secret = resp.data.secret;
                this.self.handle = handle;
                if (al && resp.data.Handle!="") {
                  this.self.handle = resp.data.handle;
                  this.self.autologin = true;
                  this.self.sealedauths = resp.data.sealedauths || {};
                }
                this.self.password = password;
                // Client.rmKey({publicKey:this.self.serverpubkey});
                this.self.serverpubkey = resp.data.serverpubkey;
                Client.init(_room.id, this.mycrypto.get());
                Client.addKey(this.mesharedcrypto.get());
                Client.connect();
            })
            .catch(err => {
                this.isRequesting = false;
                this.notify(err, notifType.error);
            });
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

            const bPub = this.mycrypto.publicKey();
            const oldest = this.validPeers().slice(0).sort(sortBySince).pop();
            const data = {
              type: Client.MsgType["typing"],
              publicKey: bPub,
            }
            Client.broadcast(data, oldest.shared.publicKey, oldest.shared);

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
            const bPub = this.mycrypto.publicKey();
            const oldest = this.validPeers().slice(0).sort(sortBySince).pop();
            if (!oldest) {
              console.error("could not find a peer to send message")
              return
            }
            const data = {
              type: Client.MsgType["message"],
              data: userMsg,
              timestamp: new Date(),
            }
            Client.broadcast(data, oldest.shared.publicKey, oldest.shared);
            return
          }

          var commandName = m[1];
          if (!(commandName in commands)) {
              this.messages.push({
                  type: "error",
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
          console.log("mycrypto: ", this.mycrypto.get())
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
              type: Client.MsgType["help"],
              message: message
          });
          this.scrollToNewester();
        },

        handleSetHandle(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)");
          var matches = userMsg.match(re);
          this.changeHandle(matches[2])
        },

        handlePing(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)\\s+(.*)");
          var matches = userMsg.match(re);
          const bPub = this.mycrypto.publicKey();
          const peer = this.validPeers().filter( (p) => {return p.handle===matches[2];}).shift()
          if (!peer) {
            return
          }
          const data = {
            type: Client.MsgType["ping"],
            data: matches[3],
          }
          Client.send(data, peer.publicKey);
          // const nonce = this.mycrypto.newNonce();
          // const msg = this.mycrypto.encrypt(JSON.stringify(data), nonce, peer.publicKey);
          // Client.sendCrypted(msg, peer.publicKey, bPub, nonce);
        },

        handleWhisper(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)\\s+(.*)");
          var matches = userMsg.match(re);
          const bPub = this.mycrypto.publicKey();
          const peer = this.validPeers().filter( (p) => {return p.handle===matches[2];}).shift()
          if (!peer) {
            return
          }
          const data = {
            type: Client.MsgType["whisper"],
            data: matches[3],
          }
          Client.send(data, peer.publicKey);
          // const nonce = this.mycrypto.newNonce();
          // const msg = this.mycrypto.encrypt(JSON.stringify(data), nonce, peer.publicKey);
          // Client.sendCrypted(msg, peer.publicKey, bPub, nonce);
        },

        handleGrowl(userMsg, commandName, command) {
          var re = new RegExp("^(/"+commandName+")\\s+([^\\s]+)\\s+(.*)");
          var matches = userMsg.match(re);
          const data = {
            type: Client.MsgType["growl"],
            data: {
              to: matches[2],
              from: this.self.handle,
              msg: matches[3],
            },
          }
          Client.send(data, this.self.serverpubkey);
        },

        handleLogout() {
            if (!confirm("Logout?")) {
                return;
            }
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
              type: Client.MsgType["room.dispose"],
            }
            Client.send(data, this.self.serverpubkey);
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

        // Clear all states.
        clear() {
            this.handle = "";
            this.password = "";
            this.message = "";
            this.self = {};
            this.messages = [];
            this.peers = [];
            //todo: more to clear.
        },

        // WebSocket client event handlers.
        onConnect() {
            // Client.getPeers();
        },

        onDisconnect(typ) {
            switch (typ) {
                case Client.MsgType["disconnect"]:
                    this.notify("Disconnected. Retrying ...", notifType.notice);
                    break;

                case Client.MsgType["peer.ratelimited"]:
                    this.notify("You sent too many messages", notifType.error);
                    this.toggleChat();
                    break;

                case Client.MsgType["room.full"]:
                    this.notify("Room is full", notifType.error);
                    this.toggleChat();
                    break;

                case Client.MsgType["room.dispose"]:
                    this.notify("Room disposed", notifType.error);
                    this.toggleChat();
                    this.disposed = true;
                    break;
            }
            // window.location.reload();
        },

        onReconnecting(timeout) {
          this.notify("Disconnected. Trying to connect...", notifType.notice, timeout);
      		var reconnect_timer = setTimeout(function () {
      			reconnect_timer = null;
            this.notify("Logging in", notifType.notice);
            const bpub = this.mycrypto.publicKey();
            this.isRequesting = true;
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
                    setTimeout(function () {
                      this.onReconnecting(timeout)
                		}.bind(this), timeout/2);
                    return;
                }
                this.self.avatar = this.hashColor(bpub);
                this.self.since = resp.data.since;
                this.self.serverpubkey = resp.data.serverpubkey;
                Client.init(_room.id, this.mycrypto.get());
                Client.addKey(this.mesharedcrypto.get());
                Client.connect();
                this.chatOn = true;
                this.isRequesting = false;
                this.deNotify();
            })
            .catch(err => {
                this.isRequesting = false;
                this.notify(err, notifType.error);
                setTimeout(function () {
                  this.onReconnecting(timeout)
            		}.bind(this), timeout/2);
            });

      		}.bind(this), timeout);
        },

        // onPeerSelf(data) {
        //     this.self = {
        //         ...data.data,
        //         avatar: this.hashColor(data.data.id)
        //     };
        // },

        validPeers() {
          const bPub = this.mycrypto.publicKey();
          return this.peers.filter( (p) => {
            return p.publicKey===bPub || (p.wasChallenged && p.passChallenge && p.validHandle);
          })
        },

        onPeerJoinLeave(cleardata, data) {
            if (data.from!==this.self.serverpubkey){
              console.error("must be issued by the server", data, cleardata)
              return
            }
            const bPub = this.mycrypto.publicKey();
            const peer = cleardata;
            peer.avatar = this.hashColor(peer.publicKey);
            if (peer.publicKey===bPub){
              return
            }

            // Add / remove the peer from the existing list.
            if (cleardata.type === Client.MsgType["peer.join"]) {
                delete(peer.type)
                peer.passChallenge = false;
                peer.wasChallenged = true;
                this.issueChallenge(peer);
                this.peers.push(peer);
                this.peers.sort(sortByHandle)
                return
            }
            this.peers = this.peers.filter( notPubKey(cleardata.publicKey) );
            delete this.connectStatus[cleardata.publicKey];
            var thispeer = this.peers.filter( isPubKey(cleardata.publicKey) ).shift();
            if (thispeer){
              if (thispeer.shared){
                Client.rmKey(thispeer.shared.publicKey);
              }
              this.messages.push({
                  type: Client.MsgType["peer.leave"],
                  peer: JSON.parse(JSON.stringify(thispeer)),
                  timestamp: new Date()
              });
            }
            this.scrollToNewester();
        },

        onPeers(cleardata, data) {
            if (data.from!==this.self.serverpubkey){
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

        // issueChallenge sends a challenge to the remote to accept us.
        // The challenge is a hash of the room password, the since server time value,
        // a nonce, and the peer public key.
        issueChallenge(peer) {
          this.updateConnectionStatus(peer.publicKey, "remote", "negotiating")
          const bPub = this.mycrypto.publicKey();
          const hnonce = this.mycrypto.newNonce();
          const hash = this.mycrypto.hashRoomPwd(this.self.password, peer.since, hnonce, bPub, peer.publicKey);
          var sealedauth = "";
          if (this.self.autologin && this.self.sealedauths[peer.publicKey]) {
            sealedauth = this.self.sealedauths[peer.publicKey];
            delete(this.self.sealedauths[peer.publicKey])
          }
          const data = {
            type: Client.MsgType["challenge.query"],
            data: hash,
            nonce: hnonce,
            handle: this.self.handle,
            sealedauth: sealedauth,
          }
          Client.send(data, peer.publicKey);
        },

        // onChallengeQuery handles challenge sent by other peers,
        // it issue an accept message on success,
        // a duplicate handle message if the handles is busy.
        // The challenge consist of recrate the hash with our data,
        // and compare it to the received challenge hash.
        // If the challenge is completed, peer.passChallenge=true,
        // then the peer handle is checked for duplication.
        // If it is uniq, peer.validHandle=true an accept message is issued.
        // Otherwise a duplicate handle message is issued.
        // It saves the peer handle to the peer list.
        onChallengeQuery(cleardata, data) {
          var peer = this.peers.filter( isPubKey(data.from) ).shift();
          if (!peer) {
            console.error("invalid challenge: peer not found");
            this.issueChallengeFailed({publicKey:data.from});
            return
          }
          const bpub = this.mycrypto.publicKey()
          const hash = this.mycrypto.hashRoomPwd(this.self.password, this.self.since, cleardata.nonce, data.from, bpub);
          if(hash!==cleardata.data) {
            console.error("invalid challenge: hash mismatch");
            this.issueChallengeFailed(peer);
            return
          }
          const isRenewHandle = (peer.passChallenge && peer.validHandle);
          peer.passChallenge = true;
          peer.passSealedAuth = false;
          if (cleardata.sealedauth) {
            var nonce = cleardata.sealedauth.nonce;
            var data = cleardata.sealedauth.data;
            var sealedAuth = this.mycrypto.decrypt(data, nonce, this.self.serverpubkey)
            if (!sealedAuth) {
              console.error("invalid challenge: sealed auth can not be decrypted");
              this.issueInvalidSealedAuth(peer, cleardata.handle);
              return
            }
            if(sealedAuth.secret!==this.self.secret){
              console.error("invalid challenge: invalid secret"); // this is probably very bad.
              this.issueInvalidSealedAuth(peer, cleardata.handle);
              return
            }
            var elapsed = Date.UTC() - Date.parse(sealedAuth.date);
            var elapsedSec = Math.round(elapsed/1000);
            var maxElapsed = 60 * 5; //5 minutes
            if (elapsedSec > maxElapsed) {
              console.error("invalid challenge: token lifetime exceeded");
              this.issueInvalidSealedAuth(peer, cleardata.handle);
              return
            }
            passSealedAuth = true;
            peer.passSealedAuth = true;
          }
          peer.validHandle = true;
          this.peers.filter( notPubKey(peer.publicKey) ).map( (p) => {
            if (p.passSealedAuth) {
              return
            }
            if (p.handle===cleardata.handle) {
              if (peer.passSealedAuth) {
                p.validHandle = false;
                if (p.publicKey===bpub){
                  this.renewHandle();
                  return
                }
                this.issueDuplicateHandle(p, p.handle);
                return
              }
              const peerSince = Date.parse(peer.since);
              const pSince = Date.parse(p.since);
              peer.validHandle = pSince>peerSince;
            }
          });
          if(!peer.validHandle) {
            this.issueDuplicateHandle(peer, cleardata.handle)
            return
          }
          const oldHandle = peer.handle;
          peer.handle = cleardata.handle;
          this.peers.sort(sortByHandle)
          this.issueAccept(peer);
          if (isRenewHandle) {
            this.messages.push({
                type: Client.MsgType["peer.renewhandle"],
                oldHandle:oldHandle,
                peer: JSON.parse(JSON.stringify(peer)),
                timestamp: new Date(),
            });
          }else {
            this.messages.push({
                type: Client.MsgType["peer.join"],
                peer: JSON.parse(JSON.stringify(peer)),
                timestamp: new Date(),
            });
          }
        },

        // issueAccept notifies remote peer that it passes the callenge and
        // was accepted into out valid peer list.
        // The issue accept message contain the shared set of private/public key
        // to send chat messages.
        issueAccept(peer) {
          this.updateConnectionStatus(peer.publicKey, "me", "room.accept")
          const bPub = this.mycrypto.publicKey();
          const data = {
            type: Client.MsgType["room.accept"],
            shared: this.mesharedcrypto.get(),
            // myleader: this.myleader,
          }
          Client.send(data, peer.publicKey);
        },

        // issueChallengeFailed sends a chalenge failure message.
        issueChallengeFailed(peer) {
          this.updateConnectionStatus(peer.publicKey, "me", "challenge.failed")
          const bPub = this.mycrypto.publicKey();
          const data = {
            type: Client.MsgType["challenge.failed"],
          }
          Client.send(data, peer.publicKey);
        },

        // issueDuplicateHandle sends a duplicate handle message.
        // Is duplicated an handle that matches an existing handle.
        issueDuplicateHandle(peer, handle) {
          this.updateConnectionStatus(peer.publicKey, "me", "duplicate.handle")
          const bPub = this.mycrypto.publicKey();
          const data = {
            type: Client.MsgType["duplicate.handle"],
            handle: handle,
          }
          Client.send(data, peer.publicKey);
        },

        // issueInvalidSealedAuth sends an invalid sealed auth message.
        // Is invalid a sealed auth that can not be decrypted,
        // did not present the correct secret or its token lifetime exceeded.
        issueInvalidSealedAuth(peer, handle) {
          this.updateConnectionStatus(peer.publicKey, "me", "sealedauth.invalid")
          const bPub = this.mycrypto.publicKey();
          const data = {
            type: Client.MsgType["invalid.sealedauth"],
            handle: handle,
          }
          Client.send(data, peer.publicKey);
        },

        // onChallengeFailed handles challenge failed message.
        onChallengeFailed(cleardata, data) {
          const from = data.from;
          this.updateConnectionStatus(from, "remote", "challenge.failed")
        },

        // onDuplicateHandle handles duplicate message.
        // It marks the peer remote view to "duplicate.handle".
        onDuplicateHandle(cleardata, data) {
          const meHandle = this.self.handle;
          if (cleardata.handle!==meHandle) {
            return
          }
          const from = data.from;
          this.updateConnectionStatus(from, "remote", "duplicate.handle")
        },

        // onInvalidSealedAuth handles invalid sealed auth message.
        // It marks the peer remote view to "invalid.sealedauth".
        onInvalidSealedAuth(cleardata, data) {
          const meHandle = this.self.handle;
          if (cleardata.handle!==meHandle) {
            return
          }
          const from = data.from;
          this.updateConnectionStatus(from, "remote", "invalid.sealedauth")
        },

        // onAccepted handles accept message.
        // It marks the peer remote view to "room.accept".
        // It saves the peer shared keys to the peer list.
        onAccepted(cleardata, data) {
          const from = data.from;
          this.updateConnectionStatus(from, "remote", "room.accept")
          const remote = this.peers.filter( isPubKey(from) ).shift();
          if (remote){
            remote.shared = cleardata.shared;
            Client.addKey(cleardata.shared);
          }
        },

        // updateConnectionStatus
        updateConnectionStatus(pk, v, s) {
          if (!this.connectStatus[pk]) {
            this.connectStatus[pk] = {}
          }
          this.connectStatus[pk][v] = s
          this.computeConnectionStatus();
        },

        // computeConnectionStatus checks for each connection status
        // with current peer list we know of.
        // It finds the majority of responses, if it is a "dulicate.handle"
        // message, it automatically generate a new handle and triggers a "renew.handle"
        // sequence.
        // Otherwise, the connection with other peers is OK/in progress.
        computeConnectionStatus() {
          this.negotiating = Object.keys(this.connectStatus).filter((k)=>{
            return this.connectStatus[k]["remote"]==="negotiating";
          }).length;

          const acceptedPeers = this.peers.filter( (p) => {
            return p.passChallenge;
          });
          const majority = acceptedPeers.length/2;
          if (majority<1) {
            return
          }
          var totalOk = 0;
          var handleKo = 0;
          var invalidSealedAuth = 0;
          Object.keys(this.connectStatus).map( (k) => {
            if (this.connectStatus[k]["remote"]===Client.MsgType["duplicate.handle"]) {
              handleKo++;
            }else if (this.connectStatus[k]["remote"]===Client.MsgType["room.accept"]) {
              totalOk++;
            }else if (this.connectStatus[k]["remote"]===Client.MsgType["invalid.sealedauth"]) {
              invalidSealedAuth++;
            }
          })
          const totalKo = handleKo+invalidSealedAuth;
          if (handleKo>=majority) {
            this.notify("Your handle is already taken by another peer, change your nickname", notifType.error);
            this.renewHandle()
            return
          }else if (invalidSealedAuth>=majority) {
            this.notify("Your could not terminate the login sequence, your sealed authentifications are incorrect", notifType.error);
            this.renewHandle()
            return
          }else if (totalKo>=majority) {
            this.notify("You were not accepted to the room", notifType.error);
            return
          }
        },

        //renewHandle renews and handle whecking its uniquness
        // according to our current peer list.
        // It then triggers a challenge sequence to become accepted.
        renewHandle() {
          var newHandle = "";
          var uniq = false;
          const validPeers = this.validPeers();
          if (validPeers.length>0){
            while(!uniq) {
              newHandle = makeid(5);
              var k = validPeers.filter((p)=>{return p.handle===newHandle})
              uniq = k.length===0;
            }
          }
          this.changeHandle(newHandle)
        },

        // changeHandle handles the handle renewing,
        // it verifies that the new handle is uniq, or
        // shows a notficiation error.
        // It then re challenge each peer with the new handle.
        changeHandle(newHandle) {
          if (newHandle===this.self.handle) {
            return
          }
          var uniq = false;
          const validPeers = this.validPeers();
          if (validPeers.length>0){
            var k = validPeers.filter((p)=>{return p.handle===newHandle})
            uniq = k.length===0;
          }
          if(!uniq){
            this.notify("Your handle is already taken by another peer, change your nickname", notifType.error);
            return
          }
          const bPub = this.mycrypto.publicKey();
          this.self.handle = newHandle;
          this.peers.filter( notPubKey(bPub) ).map( this.issueChallenge )
          this.peers.filter( isPubKey(bPub) ).map( (p) => {
            p.handle = newHandle;
          })
        },

        onTyping(cleardata, data) {
            const peer = this.validPeers().filter( isPubKey(cleardata.publicKey) ).pop();
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
            const peer = this.validPeers().filter( (p) => { return p.publicKey===from; }).pop();
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
          var d = data.data.data;
          if (data.type==Client.MsgType["uploading"]) {
            var found = false;
            this.messages.map((m) => {
              if (m.uid===d.uid){
                m.files=d.files;
                m.percent=d.percent;
                m.type=data.type;
                found=true;
              }
            });
            if(!found) {
              this.messages.push({
                type: data.type,
                timestamp: new Date(),
                uid: d.uid,
                files: d.files,
                percent: d.percent,
                peer: {
                  id: data.data.peer_id,
                  handle: data.data.peer_handle,
                  avatar: this.hashColor(data.data.peer_id)
                }
              });
            }
          }else {
            var found = false;
            this.messages.map((m) => {
              if (m.uid===d.uid){
                if(d.res) {
                  m.res=d.res.data;
                }
                m.files = m.files || [];
                m.err=d.err;
                m.type=data.type;
                found=true;
              }
            });
            if(!found) {
              var res = {};
              if (d.res) {
                res = d.res.data;
              }
              this.messages.push({
                type: data.type,
                timestamp: new Date(),
                uid: d.uid,
                res: res,
                files: [],
                err: d.err,
                peer: {
                  id: data.data.peer_id,
                  handle: data.data.peer_handle,
                  avatar: this.hashColor(data.data.peer_id)
                }
              });
            }
          }
          this.scrollToNewester();
        },

        onPing(cleardata, data) {
          if (document.hasFocus()) {
            return
          }
          const peer = this.validPeers().filter( (p) => { return p.publicKey===data.from;}).pop();
          if (!peer) {
            console.error("peer not found", data.from)
            return
          }
          if (Notify.needsPermission) {
            this.messages.push({
              type: Client.MsgType["ping"],
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
          const peer = this.validPeers().filter( isPubKey(data.from) ).pop();
          if (!peer) {
            console.error("peer not found", data.from)
            return
          }
          this.messages.push({
            type: Client.MsgType["whisper"],
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

        // Register chat client events.
        initClient() {
            Client.on(Client.MsgType["connect"], this.onConnect);
            Client.on(Client.MsgType["disconnect"], (data) => { this.onDisconnect(Client.MsgType["disconnect"]); });
            Client.on(Client.MsgType["peer.ratelimited"], (data) => { this.onDisconnect(Client.MsgType["peer.ratelimited"]); });
            Client.on(Client.MsgType["room.dispose"], (data) => { this.onDisconnect(Client.MsgType["room.dispose"]); });
            Client.on(Client.MsgType["room.full"], (data) => { this.onDisconnect(Client.MsgType["room.full"]); });
            Client.on(Client.MsgType["reconnecting"], this.onReconnecting);

            Client.on(Client.MsgType["peer.list"], this.onPeers);
            Client.on(Client.MsgType["peer.join"], this.onPeerJoinLeave);
            Client.on(Client.MsgType["peer.leave"], this.onPeerJoinLeave);
            Client.on(Client.MsgType["message"], this.onMessage);
            Client.on(Client.MsgType["motd"], this.onMotd);
            Client.on(Client.MsgType["typing"], this.onTyping);
            Client.on(Client.MsgType["ping"], this.onPing);
            Client.on(Client.MsgType["whisper"], this.onWhisper);
            Client.on(Client.MsgType["challenge.query"], this.onChallengeQuery);
            Client.on(Client.MsgType["challenge.failed"], this.onChallengeFailed);
            Client.on(Client.MsgType["duplicate.handle"], this.onDuplicateHandle);
            Client.on(Client.MsgType["room.accept"], this.onAccepted);
            // Client.on(Client.MsgType["uploading"], this.onUpload);
            // Client.on(Client.MsgType["upload"], this.onUpload);
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
          this.isDraggingOver=false
          // based on https://www.raymondcamden.com/2019/08/08/drag-and-drop-file-upload-in-vuejs
          let droppedFiles = e.dataTransfer.files;
          if(!droppedFiles) return;
          var uid = Math.round(new Date().getTime() + (Math.random() * 100));
          // this tip, convert FileList to array, credit: https://www.smashingmagazine.com/2018/01/drag-drop-file-uploader-vanilla-js/
          var ok = true;
          let formData = new FormData();
          var files = [];
          ([...droppedFiles]).forEach((f,x) => {
            if (x>=20) {
              this.notify("Too much files to upload", notifType.error);
              ok = false;
              return
            }
            formData.append('file'+(x), f);
            files.push(f.name)
          })
          if (!ok) {
            return
          }
          Client.sendMessage(Client.MsgType["uploading"], {uid:uid,files:files,percent:0});

          axios.post("/r/" + _room.id + "/upload", formData,
            {
              headers: {
                  'Content-Type': 'multipart/form-data'
              },
              onUploadProgress: function( progressEvent ) {
                var p = parseInt( Math.round( ( progressEvent.loaded / progressEvent.total ) * 100 ) );
                Client.sendMessage(Client.MsgType["uploading"], {uid:uid,files:files,percent:p});
              }
            }
          ).then(res => {
            if (res.error){
              this.notify(res.error, notifType.error);
              Client.sendMessage(Client.MsgType["upload"], {uid:uid,err:res.error});
            }else{
              Client.sendMessage(Client.MsgType["upload"], {uid:uid,res:res.data});
            }
          })
          .catch(err => {
            Client.sendMessage(Client.MsgType["upload"], {uid:uid,err:err.message});
            this.notify(err, notifType.error);
          });
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
