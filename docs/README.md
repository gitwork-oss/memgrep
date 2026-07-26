# memgrep docs

Documentation site for [memgrep](https://github.com/darula-hpp/memgrep).

- **Live:** [https://memgrep.gitwork.dev](https://memgrep.gitwork.dev)
- **Theme:** zinc + teal (inspired by gitwork)
- **Structure:** content-driven Next.js docs (same pattern as uigen docs)

## Local

```bash
cd docs
npm install
npm run dev
```

Open [http://localhost:4401](http://localhost:4401).

## Deploy (Vercel)

Root directory: `docs`. Production domain: `memgrep.gitwork.dev`.

```bash
cd docs
npx vercel --prod
npx vercel domains add memgrep.gitwork.dev
```

Point DNS for `memgrep.gitwork.dev` at Vercel if the domain add step asks for records.
