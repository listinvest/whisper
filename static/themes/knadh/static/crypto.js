window.cryptoutil = () => {

  var nonces = [];
  var keys = {
    publicKey: [],
    secretKey: [],
  }
  var bkeys = {
    publicKey: "",
    secretKey: "",
  }

  var init = () => {
    keys = nacl.box.keyPair();
    bkeys.publicKey = nacl.util.encodeBase64(keys.publicKey)
    bkeys.secretKey = nacl.util.encodeBase64(keys.secretKey)
  }
  var setKeys = (k) => {
    bkeys = k
    keys.publicKey = nacl.util.decodeBase64(bkeys.publicKey)
    keys.secretKey = nacl.util.decodeBase64(bkeys.secretKey)
  }
  var get = () => {
    return {
      publicKey: bkeys.publicKey,
      secretKey: bkeys.secretKey,
    }
  }

  var newNonce = () => {
    if (nonces.length > 500) {
      nonces.slices(500, nonces.length-500)
    }
    while(true) {
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const bnonce = nacl.util.encodeBase64(nonce)
      if (!nonces.includes(bnonce)) {
        nonces.push(bnonce)
        return bnonce;
      }
    }
    return ;
  }

  var hashRoomPwd = (roomPwd, since, nonceb64, mePubKeyB64, remotePubKeyB64)=>{
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

  var encrypt = (data, nonceb64, remotePubKeyB64) => {
    const bdata = nacl.util.decodeUTF8(data);
    const nonce = nacl.util.decodeBase64(nonceb64);
    const remotePubKey = nacl.util.decodeBase64(remotePubKeyB64);
    const crypted = nacl.box(bdata, nonce, remotePubKey, keys.secretKey)
    return nacl.util.encodeBase64(crypted);
  }

  var decrypt = (datab64, nonceb64, remotePubKeyB64) => {
    const data = nacl.util.decodeBase64(datab64);
    const nonce = nacl.util.decodeBase64(nonceb64);
    const remotePubKey = nacl.util.decodeBase64(remotePubKeyB64);
    const msg = nacl.box.open(data, nonce, remotePubKey, keys.secretKey);
    return nacl.util.encodeUTF8(msg);
  }

  var verify = (datab64, remotePubKeyB64) => {
    const asign = nacl.util.decodeBase64(datab64)
    const akey = nacl.util.decodeBase64(remotePubKeyB64)
    const bmsg = nacl.sign.open(asign, akey)
    return nacl.util.encodeUTF8(bmsg);
  }

  var publicKey = () => {
    return bkeys.publicKey;
  }

  return {
    init:init,
    set:setKeys,
    get:get,
    newNonce:newNonce,
    hashRoomPwd:hashRoomPwd,
    encrypt:encrypt,
    decrypt:decrypt,
    publicKey:publicKey,
    verify:verify,
  }
}
