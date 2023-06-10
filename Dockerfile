FROM node:18-alpine

EXPOSE 3000

WORKDIR /app
COPY . /app/

RUN yarn install
RUN yarn build

RUN rm -rf node_modules
ENV NODE_ENV=production
RUN yarn install

ENTRYPOINT [ "node", "build/index.js" ]
