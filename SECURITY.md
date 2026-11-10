# Security

Never commit API keys, npm tokens, `.env` files, personal configuration, user projects or chat transcripts. DSH owns model credentials; this plugin uses the host's existing model configuration.

To report a vulnerability, use [GitHub private vulnerability reporting](https://github.com/helailai666/dsh-video-editor/security/advisories/new). If private reporting is unavailable, open an issue requesting a private contact without including credentials or exploit details.

Before publishing, scan both the working tree and Git history with [Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
gitleaks dir . --redact
gitleaks git . --redact --log-opts="--all"
```

If a real credential is exposed, revoke it first. Deleting a file in a new commit does not remove it from Git history. Coordinate any history rewrite separately.
