# Use the same base image
FROM node:20-slim

# Best Practice: Combine RUN commands to reduce layers and image size.
# Add 'supervisor' back to this line
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    sed \
    supervisor \
    && rm -rf /var/lib/apt/lists/*


# Set working directory early
WORKDIR /maildrop

# --- Build Optimization ---
# 1. Copy only package files
COPY package.json package-lock.json ./

# 2. Install dependencies
RUN npm i --production

# 3. Now copy the rest of the application code.
COPY src ./src
COPY entrypoint.sh .
COPY stop-supervisor.sh .

RUN chmod +x ./entrypoint.sh ./stop-supervisor.sh

# --- ADD THIS LINE ---
# Copy the supervisor configuration file to its required location
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# --- Security Improvement ---
# Create a non-privileged user for running the application.
RUN useradd --system --no-create-home smtp \
    && chown -R smtp:smtp /maildrop

# Switch to the non-privileged user (supervisor will start as root but run haraka as smtp)
# We will handle the user switching within the supervisord.conf

# Expose all necessary ports for documentation
EXPOSE 25 465 587

# Set the entrypoint
ENTRYPOINT ["./entrypoint.sh"]