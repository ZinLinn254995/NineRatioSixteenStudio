FROM node:20-bookworm-slim

# Install FFmpeg and CA certificates for audio extraction, MP4 export, and HTTPS API requests
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create UID 1000 non-root user (required by Hugging Face Spaces and good security practice)
RUN id -u 1000 >/dev/null 2>&1 || useradd -m -u 1000 user

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN npm run build && chown -R 1000:1000 /app

USER 1000

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860

CMD ["npm", "start"]
