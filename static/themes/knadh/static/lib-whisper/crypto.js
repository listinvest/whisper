
class CryptoUtils {
  constructor(keys){
    this.nonces = [];
    this.keys = {
      publicKey: [],
      secretKey: [],
    };
    this.bkeys = {
      publicKey: "",
      secretKey: "",
    }
    if (keys) {
      this.set(keys)
    }else {
      this.init()
    }
  }

  init(){
    this.keys = nacl.box.keyPair();
    this.bkeys.publicKey = nacl.util.encodeBase64(this.keys.publicKey)
    this.bkeys.secretKey = nacl.util.encodeBase64(this.keys.secretKey)
  }

  set(k) {
    this.bkeys = k
    this.keys.publicKey = nacl.util.decodeBase64(this.bkeys.publicKey)
    this.keys.secretKey = nacl.util.decodeBase64(this.bkeys.secretKey)
  }

  get() {
    return {
      publicKey: this.bkeys.publicKey,
      secretKey: this.bkeys.secretKey,
    }
  }

  newNonce(){
    if (this.nonces.length > 500) {
      this.nonces.slice(500, this.nonces.length-500)
    }
    while(true) {
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const bnonce = nacl.util.encodeBase64(nonce)
      if (!this.nonces.includes(bnonce)) {
        this.nonces.push(bnonce)
        return bnonce;
      }
    }
    return ;
  }

  hashRoomPwd(roomPwd, since, nonceb64, mePubKeyB64, remotePubKeyB64){
    const encoder = new TextEncoder();
    const shaObj = new jsSHA("SHA-512", "TEXT", { encoding: "UTF8" });
    shaObj.update(mePubKeyB64);
    shaObj.update(since);
    shaObj.update(nonceb64);
    shaObj.update(remotePubKeyB64);
    shaObj.update(roomPwd);
    const hash = shaObj.getHash("UINT8ARRAY");
    return nacl.util.encodeBase64(hash);
  }

  encrypt(data, nonceb64, remotePubKeyB64) {
    const bdata = nacl.util.decodeUTF8(data);
    const nonce = nacl.util.decodeBase64(nonceb64);
    const remotePubKey = nacl.util.decodeBase64(remotePubKeyB64);
    const crypted = nacl.box(bdata, nonce, remotePubKey, this.keys.secretKey)
    return nacl.util.encodeBase64(crypted);
  }

  decrypt(datab64, nonceb64, remotePubKeyB64) {
    const data = nacl.util.decodeBase64(datab64);
    const nonce = nacl.util.decodeBase64(nonceb64);
    const remotePubKey = nacl.util.decodeBase64(remotePubKeyB64);
    const msg = nacl.box.open(data, nonce, remotePubKey, this.keys.secretKey);
    return nacl.util.encodeUTF8(msg);
  }

  verify(datab64, remotePubKeyB64) {
    const asign = nacl.util.decodeBase64(datab64)
    const akey = nacl.util.decodeBase64(remotePubKeyB64)
    const bmsg = nacl.sign.open(asign, akey)
    return nacl.util.encodeUTF8(bmsg);
  }

  publicKey() {
    return this.bkeys.publicKey;
  }
}
