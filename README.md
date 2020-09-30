# Whisper

Whisper is a fork of [Niltalk](http://github.com/knadh/niltalk), a web based disposable chat server. It allows users to create
password protected disposable, ephemeral chatrooms and invite peers to chat rooms. Rooms can be disposed of at any time.

Whisper implements peer to peer message [encryption](https://nacl.cr.yp.to/) to improve users privacy.

![niltalk](https://user-images.githubusercontent.com/547147/78459728-9f8c3180-76d8-11ea-8c0a-9cf9bfe64341.png)

## Features

- configuration less startup, single file executable
- embedded tor instance for instant connectivity
- ssl support with JIT self signed certificate generator,
loading of regular pregenerated signed certificate or letsencrypt
- work at home or in the cloud
- persistent and ephemeral rooms
- multi theming

## Installation

### Manual
- Download the [latest release](https://github.com/clementauger/whisper/releases) for your platform and extract the binary.
- Run `./whisper --new-config` to generate a sample config.toml and add your configuration.
- Run `./whisper` and visit http://localhost:9000.

### Systemd
- Run `whisper --new-unit`, and follow [the guide](systemd.md)

### Customisation
To customize the user interface, start by extracting the embedded assets using `whisper --extract-themes`.
Then you can edit existing themes or create a new one by adding a folder under `static/themes`.

To rebuild template JIT during development phase, use the `--jit` flag.

### License
The original license was kept as is, thus AGPL3.


### Security
This was not proof audited for security issues, use it at your own risks.

In the big picture, when you, Bob, login a room, your browser generates a pair of
cryptographic keys, the public key is sent to the server and saved to the peer list.
When a new user, Alice, login to the room it fetches the peer list and their public key. Alice and Bob both then send each other a query challenge to ensure they can trust each other.
The challenge consist of a hash comparison of the room password and other things. If the challenge succeed, both peers send each other an accept message.
Both messages contain a shared private key that both Bob and Alice knows and can use to generate and exchange secure messages over the network.
If the challenges fails, the peer is ignored and the communication does not happen.
To send a message to the room the peer has to select, preferably, the oldest connected peer in the room and use its shared private key to generate the protected
message. Upon reception, an accepted peer, can lookup for the matching pair of private keys to decode the message and print it on screen.
