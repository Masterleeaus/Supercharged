FROM node:22

WORKDIR /app

# Copy only package files first (this layer caches independently)
COPY package*.json ./

# Install dependencies - cached until package.json changes
RUN npm ci --omit=dev

# Copy source code - invalidates cache only when code changes
COPY . .

# Build
RUN npm run build

EXPOSE 3005

CMD ["npm", "start"]
