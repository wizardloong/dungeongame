FROM node:20-alpine

WORKDIR /app

COPY app/package.json /app
RUN npm install

COPY app/ /app
COPY env/.env /app/.env

EXPOSE 3000

CMD ["npm", "start"]