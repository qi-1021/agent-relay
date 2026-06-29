FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN mkdir -p data uploads
EXPOSE 3210
CMD ["node", "src/server.js"]
