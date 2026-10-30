# Releasing

For the maintainer. This code repository (`rm4n0s/english-tutor-plugin-firefox`) is private and stays private. Firefox cannot read a private repository, so releases go to a separate **public** one, [`rm4n0s/english-tutor-releases`](https://github.com/rm4n0s/english-tutor-releases). It holds only:

- the signed `.xpi` files, as GitHub Release assets, with tags `vX.Y.Z`;
- `updates.json`, the update manifest that installed copies read (SPEC section 3.2);
- a `README.md` that is the install guide for users (a copy of [INSTALL.md](INSTALL.md)).

The code is never pushed there. **The releases repo must stay public**: if it were made private, nobody could download a release, and installed copies would stop finding updates. Its first commit (for example a README made by `gh repo create --public --add-readme`) must exist before the first `gh release create`.

The extension is never listed on addons.mozilla.org (AMO). Each release is signed by AMO as an **unlisted** version, so it installs and stays installed in release Firefox. AMO has version 0.1.0 already (signed by hand), so a version number can never be reused: 0.2.0 was signed but never published, so the first public release is 0.3.0.

## One time: the AMO account and key

1. Make an account at [addons.mozilla.org](https://addons.mozilla.org) and accept the Firefox Add-on Distribution Agreement when the Developer Hub asks (it asks the first time an add-on is submitted).
2. Make an API key at <https://addons.mozilla.org/developers/addon/api/key/>. It has two values, the issuer (`WEB_EXT_API_KEY`) and the secret (`WEB_EXT_API_SECRET`).
3. Put them in `.env` in the repository root, which is gitignored:

   ```sh
   WEB_EXT_API_KEY=user:12345:67
   WEB_EXT_API_SECRET=0123456789abcdef...
   ```

   Or export them in the shell that runs `npm run sign`. The environment wins over `.env`. The key is never committed, printed, logged or written to a file by the scripts: `scripts/sign.mjs` hands it to `web-ext` through the child process's environment, never on a command line. If a secret leaks, revoke it on the same page and make a new one.

## Release checklist

1. Start from an up-to-date `main` and make a branch (`feat/...` or `fix/...`). Bump `version` in `src/manifest.json`, `package.json` and `package-lock.json` (its own version, at the top and under `packages[""]`) to the new number. A number that AMO already has is refused.
2. Run the Definition of done (CLAUDE.md): `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` then `npm run lint:ext`, and `npm run screenshots`. Do the manual smoke check (README, "Manual smoke check") with a real LLM.
3. Commit, and publish the commit to `main` as for any change. The tree must be clean at the commit you release: `npm run sign` refuses otherwise, because the source code it uploads to AMO is `git archive HEAD`.
4. `npm run sign`. It checks that the tree is clean and that the three versions match, builds, makes `web-ext-artifacts/english-tutor-<version>-source.zip` with `git archive`, runs `web-ext sign -s dist --channel=unlisted --upload-source-code <zip> --artifacts-dir web-ext-artifacts`, and prints the path of the signed `.xpi`. Signing waits for AMO and can take a few minutes.
5. `npm run release-files -- web-ext-artifacts/<id>-<version>.xpi`. It writes `release-out/<version>/` (gitignored) with `english-tutor-<version>.xpi`, `updates.json` and `README.md`, and prints the commands of the next step. `updates.json` keeps every earlier version: it is merged from the file in the releases repo (read from its raw address; `--previous <path>` reads a local copy instead, and `--offline` starts from nothing, for tests). Each entry has `update_link` (the release asset's address) and `update_hash` (the `sha256:` of the signed file).
6. Run the printed commands, in order: `gh release create vX.Y.Z ... --repo rm4n0s/english-tutor-releases` (this uploads the `.xpi` first), then the commit and push of `updates.json` and `README.md` to the releases repo. `updates.json` goes last on purpose: installed copies see the new version only when it is pushed, and by then the file they will download exists.
7. Check: open `https://raw.githubusercontent.com/rm4n0s/english-tutor-releases/main/updates.json` (the new entry is there, after GitHub's cache of a few minutes), download the `.xpi` from the release and install it in a Firefox, and in a Firefox that has the previous version, `about:addons`, gear, **Check for Updates**.

The `update_url` in the manifest cannot be changed later for installed copies (they keep the one of the version they run), so the raw address and the name `updates.json` stay as they are.

## When signing is refused or times out

- **"Version already exists"**: AMO accepts each version number once, even when signing failed afterwards. Bump the version (all three files), commit, and sign again.
- **Timeout** (`web-ext` stops waiting for AMO): the submission stays in AMO's queue and is still signed. Do not run `npm run sign` again with the same version: it would be refused as a duplicate. Open the [Developer Hub](https://addons.mozilla.org/developers/addons), find English Tutor, open the version, and download the signed file there. Put it in `web-ext-artifacts/` as `<id>-<version>.xpi` and continue with `npm run release-files`.
- **Refused after a review** (validation errors, or the reviewers ask a question about the source): read the message on the Developer Hub, fix it, bump the version and sign again. AMO needs to be able to rebuild the extension from the uploaded source: the README's `npm ci` and `npm run build` are the build instructions, and the zip holds exactly the commit that was built.
- **Wrong key** (401 or "invalid JWT"): the key or secret is wrong, expired or revoked. Make a new key (see above).
- **Signed but not released**: the signed `.xpi` in `web-ext-artifacts/` is all that `release-files` needs. Keep it until the release is done.
