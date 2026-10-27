# Dopamine Roulette

A real-time multiplayer browser game built with one Node.js server file, Express, and Socket.IO. The frontend is embedded in `server.js` and styled with Tailwind's CDN.

## Features
- Create a room and share a five-character code or invite link.
- No account or login required.
- Up to 12 players per room.
- Secret simultaneous choices: Safe, Mystery Box, or Sabotage.
- Synchronized 8-second choice timer and reveal.
- Live scoreboard, host handoff, mobile-friendly layout.
- `/health` endpoint for deployment health checks.

## Run locally
Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000 in two or more browser tabs/devices. For other devices on the same Wi-Fi, use your computer's LAN IP and port 3000.

## Deploy to Render
1. Create a new Git repository and add `server.js`, `package.json`, and `render.yaml`.
2. Push the repository to GitHub.
3. In Render, choose **New + → Blueprint** and select the repository.
4. Render reads `render.yaml`, installs dependencies, and starts the app. Open the generated public URL.
5. Test the public URL on two separate devices.

You can also create a Render Web Service manually with build command `npm install`, start command `npm start`, and health check path `/health`.

## Important deployment notes
- This is an in-memory MVP. Rooms and scores disappear when the server restarts, and one server instance is intended. Do not scale to multiple instances without adding a shared Socket.IO adapter and shared room state (for example, Redis).
- Tailwind is loaded from its CDN, so the client needs internet access. For production with a strict content policy, compile Tailwind locally.
- Room codes are for casual private rooms, not a security boundary. Do not put sensitive information in room names or chat (there is no chat).
- The game uses random game points, not real-money gambling. No real-money payments or prizes are included.
- Sabotage selects a random other connected player and subtracts 2 points, with a floor of 0. Mystery Box gives 0, 1, 3, or 5 points. Safe gives 2 points.
- A player who disconnects during a round is retained in the room state until room cleanup. Refreshing the page creates a new socket identity; reconnect recovery is not implemented.

## Troubleshooting
- If the port is already in use, set `PORT=3001` before starting.
- If rooms do not sync on a hosted service, confirm the service is running as one instance.
