FROM node:22-alpine AS builder
WORKDIR /app

# Declare build-time variables so Vite can bake them into the bundle.
ARG VITE_API_URL
ARG VITE_API_KEY
ARG VITE_GOOGLE_CLIENT_ID

# Expose them as ENV so Vite's import.meta.env picks them up during `npm run build`.
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
