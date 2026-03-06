# Contributing to FreeCustom.Email Backend

First off, thank you for considering contributing to the FreeCustom.Email backend (Maildrop). It's people like you that make such a vibrant community.

## Where do I go from here?

If you've noticed a bug or have a feature request, [make one](https://github.com/DishIs/fce-backend/issues/new)! It's generally best if you get confirmation of your bug or approval for your feature request this way before starting to code.

### Fork & create a branch

If this is something you think you can fix, then [fork Maildrop](https://github.com/DishIs/fce-backend/fork) and create a branch with a descriptive name.

A good branch name would be (where issue #38 is the ticket you're working on):

```sh
git checkout -b 38-add-awesome-new-feature
```

### Get the code

```sh
git clone https://github.com/DishIs/fce-backend.git
cd fce-backend
git checkout 38-add-awesome-new-feature
```

### Setting up the environment

The Maildrop backend is a multi-service application that runs in Docker. You will need to have Docker and Docker Compose installed on your system.

1.  **Create a `.env` file** in the root of the project by copying the `.env.example` file.
2.  **Fill in the required environment variables.**
3.  **Run the application:** `docker-compose up -d`

### Make your changes

Make your changes to the codebase. Be sure to follow the existing code style.

### Test your changes

Make sure your changes don't break any existing functionality.

### Commit your changes

Make sure your commit messages are descriptive.

```sh
git commit -m "feat: Add awesome new feature"
```

### Push to your fork

```sh
git push origin 38-add-awesome-new-feature
```

### Make a pull request

Go to the GitHub repository and make a pull request.

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
