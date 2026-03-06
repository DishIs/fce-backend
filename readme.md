<p align="center">
  <a href="https://www.freecustom.email">
    <img src="https://www.freecustom.email/logo.webp" alt="FreeCustom.Email Logo" width="128" height="128">
  </a>
</p>

<h1 align="center">FreeCustom.Email Backend (Maildrop)</h1>

<p align="center">
  <a href="https://github.com/DishIs/fce-backend/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/DishIs/fce-backend" alt="License">
  </a>
  <a href="https://github.com/DishIs/fce-backend/issues">
    <img src="https://img.shields.io/github/issues/DishIs/fce-backend" alt="Issues">
  </a>
  <a href="https://github.com/DishIs/fce-backend/pulls">
    <img src="https://img.shields.io/github/issues-pr/DishIs/fce-backend" alt="Pull Requests">
  </a>
</p>

## About

This repository contains the backend source code for [FreeCustom.Email](https://www.freecustom.email), a powerful and privacy-focused temporary email service. The backend, codenamed Maildrop, is a multi-service application built with Node.js, TypeScript, and Docker. It's responsible for handling everything from receiving and storing emails to managing user accounts and subscriptions.

This project is the backend component of the FreeCustom.Email service. The frontend is also open-source and can be found at [DishIs/temp-mail](https://github.com/DishIs/temp-mail).

## Features

*   **Custom SMTP Server:** A highly customized Haraka SMTP server for high-performance email processing.
*   **Microservices Architecture:** A collection of services for different tasks, including a REST API, background workers, and more.
*   **Real-time Updates:** WebSocket integration for real-time updates to the frontend.
*   **Secure and Scalable:** Designed with security and scalability in mind, using technologies like MongoDB, Redis, and Docker.

## Getting Started

### Prerequisites

*   Docker
*   Docker Compose
*   Your own domain names for the API and SMTP server.

### Installation

1.  **Clone the repository:**
    ```sh
    git clone https://github.com/DishIs/fce-backend.git
    cd fce-backend
    ```
2.  **Update `docker-compose.yml`:**
    Before you can start the application, you need to replace all instances of `api2.freecustom.email` and `mx.freecustom.email` with your own domain names.

3.  **Create a `.env` file:**
    ```sh
    cp .env.example .env
    ```
4.  **Fill in the environment variables** in the `.env` file.

5.  **Initial SSL Certificate Setup (Important):**
    The `certbot-renew` service will not start without an initial SSL certificate. You need to run the `certbot` service once to generate the initial certificate.
    ```sh
    docker-compose up -d certbot
    ```
    Once the `certbot` service has finished running, you can stop it. The `certbot-renew` service will then be able to start and will handle renewing the certificate automatically.

6.  **Start the application:**
    ```sh
    docker-compose up -d
    ```

## SMTP Server: `smtp` vs. `smtp-fast`

This repository contains two different SMTP server configurations: `smtp` and `smtp-fast`.

*   **`smtp`**: This is an older, slower configuration that performs more email checks and has better spam detection. It is not actively maintained.
*   **`smtp-fast`**: This is the configuration that FreeCustom.Email actually uses. It is a high-performance configuration that is designed for speed. It is actively maintained.

The `docker-compose.yml` file is configured to use the `smtp-fast` service by default.

## Haraka Setup (`smtp-fast`)

The `smtp-fast` service uses Haraka, a highly extensible and customizable SMTP server written in Node.js. Our Haraka setup is heavily customized with a series of plugins to create a high-performance email processing pipeline.

### Configuration Files

The configuration for the Haraka server is located in the `smtp-fast/src/config` directory. Here are some of the most important files:

*   **`plugins`**: This file defines the order in which the Haraka plugins are executed.
*   **`smtp.ini`**: This file contains the main configuration for the SMTP server.
*   **`redis.ini`**: This file configures the connection to the Redis server.
*   **`queue.redis.ini`**: This file configures the custom Redis queue plugin.

### Custom Plugins

We use several custom plugins to add functionality to the Haraka server. These plugins are located in the `smtp-fast/src/plugins` directory.

*   **`rcpt_to_mongo.js`**: Checks if the recipient is a valid user by looking them up in the MongoDB database.
*   **`data.blocklist.js`**: Blocks emails from muted senders.
*   **`queue.redis.js`**: Queues emails in Redis for later processing by the API service.
*   **`stats.redis.js`**: Records statistics to Redis.

## Public API (v1)

This backend also hosts our public API v1, which can be accessed at [https://www.freecustom.email/api](https://www.freecustom.email/api). No manual setup is required to use this public API. You can also explore and test the API endpoints live at the `/api/playground` (e.g., `https://www.freecustom.email/api/playground`).

## Contributing

We welcome contributions from the community! Please read our [Contributing Guide](CONTRIBUTING.md) to learn how you can get involved.

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.

## Contact

DishIs Technologies - [@DishIs](https://github.com/DishIs)

Project Link: [https://github.com/DishIs/fce-backend](https://github.com/DishIs/fce-backend)
