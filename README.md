# SimpleRain

SimpleRain is a single-game, static web app for the pond tile game formerly copied from browserP2P.

## What was kept

- Peer-to-peer WebRTC networking through PeerJS signaling.
- Automatic host/join: open the app and it joins the current SimpleRain session, or becomes host if none exists.
- Host-owned authoritative game state.
- Automatic state sync from the host cache for all joiners.
- Cross-network play when WebRTC can connect peers through NAT traversal or relay; the auto room uses a shared public PeerJS broker, not LAN-only discovery.
- A reset button for restarting the current game for everyone.
- Offline app-shell caching for only the SimpleRain files.

## What was removed

- Other games.
- Game mode switching.
- Chat/text messaging.
- Voice and microphone features.
- Camera/video features.
- Drawing tools.
- Manual room code, QR, and advanced lobby UI.

## Run locally

From the repo root:

```bash
python -m http.server 8000
```

Open `http://localhost:8000` in two tabs or devices. The first tab hosts; later tabs join automatically.
