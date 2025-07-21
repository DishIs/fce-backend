# Use the same base image
FROM node:20-slim

# Best Practice: Combine RUN commands to reduce layers and image size.
# Removed bind9, dnsutils, supervisor (we will install it via npm for simplicity)
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    sed \
    && rm -rf /var/lib/apt/lists/*

# Set working directory early
WORKDIR /maildrop

# --- Build Optimization ---
# 1. Copy only package files
COPY package.json package-lock.json ./

# 2. Install dependencies (including supervisor)
# This layer is only rebuilt if package.json changes.
RUN npm i --production

# 3. Now copy the rest of the application code.
# Changes here won't trigger a new `npm i`.
COPY src ./src
COPY entrypoint.sh .
COPY stop-supervisor.sh .

# --- Security Improvement ---
# Create a non-privileged user for running the application.
# This user matches the 'user=smtp' in smtp.ini.
RUN useradd --system --no-create-home smtp \
    && chown -R smtp:smtp /maildrop

# Switch to the non-privileged user.
# Haraka will run as 'smtp', but it needs to start as root to bind low ports.
# We will handle this in the entrypoint script.

# Expose all necessary ports for documentation
EXPOSE 25 465 587

# Set the entrypoint
ENTRYPOINT ["./entrypoint.sh"]