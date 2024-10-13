# Use a multi-stage build to keep the final image small
FROM node:slim AS builder
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# Use a clean base image for the final image
FROM node:slim

ENV NODE_ENV production
USER node

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

# Copy the built application from the builder stage
COPY --from=builder /app/build ./build

EXPOSE 3001

CMD ["node", "build/main.js"]