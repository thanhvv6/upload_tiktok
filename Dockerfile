# ---- Stage 1: Build frontend ----
FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Backend (Playwright + Node) ----
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
EXPOSE 3010
CMD ["node", "server.js"]

# ---- Stage 3: Frontend (nginx) ----
FROM nginx:alpine AS frontend
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 3009
