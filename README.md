# Satisfactory Status Monitor

This Node.js program acts as a bridge between your Satisfactory dedicated server and a web-based dashboard (or any other client) to display real-time server status information. 

## Features

### Real-time Updates

Uses a combination of UDP polling and Satisfactory's HTTPS API to provide near real-time updates on server status, including:
- Game State
- Online Players
- Tech Tier
- Game Phase
- Average Tick Rate

### WebSocket

Socket.IO is used to broadcast server state changes to connected clients.

## How it Works

1. The script periodically sends UDP packets to the Satisfactory server to check for basic state changes (like player count changes).
2. When a change is detected via UDP, the script makes a secure HTTPS request to the server's API to fetch the complete updated server state.
3. The updated state is then broadcast to all connected clients via Socket.IO.

## Prerequisites

- Node.js and npm
- Satisfactory Dedicated Server
- Web Dashboard (Optional)  
*A separate frontend application (like a web dashboard) to visualize the data (not included in this repository).*

## Getting Started

1. Clone the repository
   ```bash
   git clone https://github.com/ablomer/satisfactory-server-status.git
   cd satisfactory-server-status
   ```

2. Install dependencies
   ```bash
   npm install
   ```

3. Configuration  
Open `index.js` and modify the `satisfactoryConfig` object:
     ```javascript
     const satisfactoryConfig = {
         host: "your-server-ip", // Replace with your Satisfactory server's IP address
         port: 7777,                // Default Satisfactory server port 
         password: "your-password", // Replace with your server's password
         api_path: "/api/v1/"     // Satisfactory API path
     }
     ```

4. **Run the script**
   ```bash
   node index.js
   ```
   The script will start and listen for websocket connections on port `3001`.

A `Dockerfile` is also included for deployment to Docker.

## Connecting a Client

You will need a separate client application (e.g., a web dashboard) that connects to this server using Socket.IO. The server will emit a `serverUpdate` event whenever the server state changes. Your client should listen for this event and update its UI accordingly.

## Security Notes

- This script is configured to work with the self-signed certificate used by Satisfactory servers by default.  
Remove the `NODE_TLS_REJECT_UNAUTHORIZED` assignment if you have a signed certificate.
- The script is configured with CORS and allows any origin by default. I recommend changing the `origin: "*"` line to your client host address.

## Contributing

Contributions are welcome! Feel free to open issues or pull requests.