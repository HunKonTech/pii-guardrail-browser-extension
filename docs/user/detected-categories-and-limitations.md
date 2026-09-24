# Detected Categories And Limitations

Privacy Guardrail detects a beta set of structured and free-text personal or sensitive data categories before paste.

Supported beta sites:

- `chatgpt.com`
- `chat.openai.com`
- `claude.ai`
- `gemini.google.com`

## Categories

| Group | Categories |
| --- | --- |
| Identity | `PERSON`, `USERNAME` |
| Contact | `EMAIL`, `PHONE`, `ADDRESS` |
| Financial | `CREDIT_CARD`, `IBAN`, `BANK_ACCOUNT`, `SSN` |
| Network | `IP_ADDRESS`, `HOSTNAME` |
| Location | `LOCATION` |
| Password | `PASSWORD`, `SECRET` |
| Organization | `ORGANIZATION` |
| Low-signal | `URL`, `DATE`, `MISC` |

Low-signal categories can be noisy and may be disabled by default or tuned in settings.

## What Pattern Detection Handles Best

Pattern recognizers are strongest when the text has a stable format, such as email addresses, credit card numbers, IBANs, IP addresses, and some phone numbers.

## Secrets in Source Code

With **Detect secrets in code** on (the default, under Options → Code blocks), pasted text is also checked for:

- API keys and tokens with a recognizable shape: AWS access keys, GitHub, OpenAI/Anthropic, Stripe, Slack and Google API keys, and JSON Web Tokens (`SECRET`).
- Private key blocks (`-----BEGIN … PRIVATE KEY-----`) (`SECRET`).
- Values assigned to credential-like names, such as `password = "…"`, `DB_PASSWORD=…` or `"apiToken": "…"` (`PASSWORD` or `SECRET`). Values that are clearly code — function calls, `os.environ[...]`, `${VAR}` — or obvious placeholders are skipped; token-like names only count when the value looks random.
- The user, password and host of connection strings such as `postgres://user:password@host` (`USERNAME`, `PASSWORD`, `HOSTNAME`).
- Hostnames under private-network suffixes such as `.internal`, `.corp`, `.local` or `.lan` (`HOSTNAME`).
- Account names in home-directory paths such as `/Users/<name>/`, `/home/<name>/` or `C:\Users\<name>\` (`USERNAME`).

With Local AI on, code is also read with its identifiers split into words, so a name hidden in `getAnnaMuellerInvoice` or `anna_mueller_id` can be found. When a word inside an identifier is flagged, every other identifier containing that word is flagged too, so the name is replaced the same way throughout the paste.

Replacements keep the code valid. Inside quoted strings and comments the usual placeholder is used, such as `[SECRET_1]`, which is itself a valid string. Inside an identifier the brackets are dropped: `getAnnaMuellerInvoice` becomes `getPERSON_1Invoice`. When you copy code back from a reply, those placeholders are restored inside identifiers too, including new identifiers the AI built from them, such as `setPERSON_1Invoice`. Only words the detector flags are changed; other variable, function and class names stay as they are. If you untick one occurrence of a flagged identifier word in the review, the others are still replaced, and the pasted code may no longer compile.

### Renaming code identifiers

With **Rename code identifiers** on (Options → Code blocks, off by default), the classes, functions, variables, fields and parameters that pasted code declares are renamed after the review, the same way everywhere in the paste:

```text
alma = Alma("piros")        →   var3 = Class1("piros")
print(alma.nev)             →   print(var3.field2)
```

- Aliases keep the original naming style: `_etags` → `_field2`, `ClientName` → `Field3`, `MAX_SIZE` → `CONST_4`, `load_user` → `func_5`.
- Every name the code declares is renamed, however generic: `Name`, `Url`, `value`, `args`, `i`. So are the names it uses without declaring them, which are taken to come from elsewhere in your project: `(L.IsHu ? DescriptionHu : DescriptionEn)` becomes `(Class2.Field3 ? Field4 : Field5)`. Imported names and well-known library and runtime names are left alone (`requests.get`, `Console.WriteLine`, `Math.max`, `response.status_code`), as are keywords, `self`/`this`, entry points such as `main`, overridden methods and Python `__dunder__` names. Member access is renamed only on the snippet's own objects (`alma.nev`, `self.nev`, `this.nev`).
- A name in which Local AI finds personal data keeps a typed placeholder instead (`getAnnaMuellerInvoice` → `getPERSON_1Invoice`).
- Names are also renamed inside interpolations (`f"{alma.nev}"`, `` `${alma}` ``, `$"{alma}"`) and in comments, but not inside plain strings.
- Aliases are remembered: with cross-session memory on they are stored in the identity vault as `IDENTIFIER` records, so `alma` is `var3` in every later paste, including pastes that only use it. When you copy code back from a reply, every alias is restored to the original name, also in code the AI added.
- The review's **Replaced** tab shows the renamed code before you paste. Renaming also applies on protected web search pages, and to code pasted as a single line when it holds several statements (`int a = 1; var b = a;`).
- Nothing is renamed in text that does not look like code. The analysis reads code shapes rather than compiling it, so an unusual declaration can be missed (its name then stays) and a library name that happens to match one of your names can be renamed (it is restored on copy-back).

## What Local AI Helps With

Local AI can help identify context-sensitive spans such as person names, organizations, addresses, locations, usernames, passwords, and miscellaneous sensitive phrases. It can still miss spans or flag harmless text.

## Known Limits

- Detection can miss sensitive content.
- Detection can flag text that is not sensitive in context.
- Ambiguous words, short names, code, tables, and unusual formatting can reduce quality.
- Local AI can be unavailable, slow, or degraded depending on browser and device resources.
- Restoration depends on local placeholder or vault records and may not handle every response rewrite.
- Unsupported sites are outside the first public beta scope.

Privacy Guardrail supports local review before sending. It does not guarantee perfect detection, prevention, or regulatory compliance.
