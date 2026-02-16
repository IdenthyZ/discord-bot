# Usa una imagen oficial de Node.js
FROM node:20-alpine

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de dependencias
COPY package*.json ./

# Instala las dependencias
RUN npm install --production

# Copia el resto del código
COPY . .

# Expone el puerto (opcional, para bots no es necesario)
# EXPOSE 3000

# Comando para ejecutar el bot
CMD ["node", "index.js"]
