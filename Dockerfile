# Usa una imagen oficial de Node.js
FROM node:20-alpine

# Instalar dependencias del sistema y yt-dlp
RUN apk add --no-cache \
    ffmpeg \
    libsodium-dev \
    opus-dev \
    python3 \
    make \
    g++ \
    curl \
    ca-certificates

# Instalar yt-dlp manualmente para tener la última versión
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de dependencias
COPY package*.json ./

# Instala las dependencias
RUN npm install --production

# Copia el resto del código
COPY . .

# Comando para ejecutar el bot
CMD ["node", "index.js"]
