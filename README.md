# Azin Chat

Azin is a lightweight full-stack public chat app with:

- User signup/login (JWT-based auth)
- Real-time messaging with Socket.IO
- Presence + typing indicators
- File uploads and media messages
- PostgreSQL message persistence
- Redis pub/sub for chat fan-out and presence state

## Tech Stack

- **Frontend:** React + Vite + Axios + Socket.IO client
- **Backend:** Node.js + Express + Socket.IO + Multer
- **Data:** PostgreSQL
- **Realtime Infra:** Redis
- **Local Orchestration:** Docker Compose

## Project Structure

```text
.
├── backend/
│   ├── sql/init.sql
│   ├── src/
│   │   ├── auth.js
│   │   ├── db.js
│   │   ├── index.js
│   │   ├── redis.js
│   │   └── socket.js
│   └── uploads/
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js
│   │   ├── main.jsx
│   │   └── styles.css
│   └── vite.config.js
├── docker-compose.yml
└── .env
```

## Environment Variables

Create a root `.env` file:

```env
POSTGRES_USER=azin
POSTGRES_PASSWORD=azinpass
POSTGRES_DB=azin_db
JWT_SECRET=supersecretkey
```

`docker-compose.yml` sets the backend service runtime values (like `DATABASE_URL`, `REDIS_URL`, and `PORT`) for containers.

## Run with Docker (Recommended)

From the project root:

```bash
docker compose up --build
```

Services:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:4000`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

## Run Locally (Without Docker)

### 1) Start PostgreSQL + Redis

Run local instances yourself (or keep using Docker for those two services).

### 2) Backend

```bash
cd backend
npm install
DATABASE_URL=postgres://azin:azinpass@localhost:5432/azin_db \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=supersecretkey \
PORT=4000 \
npm run dev
```

### 3) Frontend

```bash
cd frontend
npm install
VITE_API_URL=http://localhost:4000 npm run dev -- --host
```

## API Overview

### Auth

- `POST /signup`  
  Body: `{ "full_name": "...", "username": "...", "password": "..." }`
- `POST /login`  
  Body: `{ "username": "...", "password": "..." }`  
  Returns JWT token and user data.

### Messages

- `GET /messages` (requires `Authorization: Bearer <token>`)
- `POST /upload` multipart file upload (requires auth), field name: `file`

## Socket Events

Client -> Server:

- `presence:join` with `{ user }`
- `typing` with `{ username, isTyping }`
- `message` with `{ userId, username, content, mediaUrl, mediaType }`

Server -> Client:

- `presence:list`
- `typing`
- `message`

## Notes

- Uploaded files are served under `/uploads`.
- This is currently a single public room chat (`public`).
- Redis pub/sub is used so message broadcasting can work across multiple backend instances.

## Scripts

### Backend (`backend/package.json`)

- `npm run start` - start server
- `npm run dev` - start in watch mode

### Frontend (`frontend/package.json`)

- `npm run dev` - start Vite dev server

## Roadmap Ideas

- Add private rooms/direct messages
- Add message acknowledgements and retries
- Add socket-level auth verification
- Add rate limiting and upload constraints
- Add automated tests and CI
