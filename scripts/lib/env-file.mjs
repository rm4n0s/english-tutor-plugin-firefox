// The AMO API key for `npm run sign`: from the environment, or from a gitignored `.env` file.
// The key is only ever passed on to the child process through its environment. It is never
// printed, logged or written anywhere.

export const KEY_NAME = "WEB_EXT_API_KEY";
export const SECRET_NAME = "WEB_EXT_API_SECRET";
export const AMO_KEYS_URL = "https://addons.mozilla.org/developers/addon/api/key/";

/**
 * Parses the text of a `.env` file: one `KEY=value` per line. Blank lines and lines starting with
 * `#` are skipped, `export ` before a key is allowed, and a value may be in single or double
 * quotes (the quotes are removed; inside double quotes `\n`, `\"` and `\\` are unescaped).
 * Unquoted values end at a ` #` comment. Lines that are not `KEY=value` are skipped.
 */
export function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    values[match[1]] = parseValue(match[2]);
  }
  return values;
}

function parseValue(raw) {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = closingQuote(raw, quote);
    if (end > 0) {
      const inner = raw.slice(1, end);
      return quote === '"' ? unescapeDouble(inner) : inner;
    }
  }
  const comment = raw.search(/\s#/);
  return (comment >= 0 ? raw.slice(0, comment) : raw).trim();
}

function closingQuote(raw, quote) {
  for (let i = 1; i < raw.length; i += 1) {
    if (quote === '"' && raw[i] === "\\") {
      i += 1;
    } else if (raw[i] === quote) {
      return i;
    }
  }
  return -1;
}

function unescapeDouble(inner) {
  return inner.replace(/\\(.)/g, (_all, ch) => (ch === "n" ? "\n" : ch));
}

/**
 * The AMO key and secret. The environment wins; a name missing from it is read from the `.env`
 * file (`readEnvFile` returns its text, or null when there is no such file). Returns
 * `{ key, secret }` or throws an Error that names the AMO API-key page (never the values).
 */
export async function loadAmoKeys(env, readEnvFile) {
  let key = nonEmpty(env[KEY_NAME]);
  let secret = nonEmpty(env[SECRET_NAME]);
  if (key === undefined || secret === undefined) {
    const text = await readEnvFile();
    if (text !== null) {
      const fromFile = parseEnv(text);
      key ??= nonEmpty(fromFile[KEY_NAME]);
      secret ??= nonEmpty(fromFile[SECRET_NAME]);
    }
  }
  if (key === undefined || secret === undefined) {
    throw new Error(
      `${KEY_NAME} and ${SECRET_NAME} are not set, in the environment or in .env. ` +
        `Make an API key at ${AMO_KEYS_URL} (see docs/RELEASING.md).`,
    );
  }
  return { key, secret };
}

function nonEmpty(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}
