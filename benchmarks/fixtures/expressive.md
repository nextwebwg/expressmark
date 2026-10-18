---
title: Release guide
tags: [operations, documentation]
---

::: warning [Before deploying]
Back up the database and confirm that the backup can be restored.
:::

Thanks, @[Ada]#maintainer, for checking the release.

::: tab [Install]
```sh
pnpm install --frozen-lockfile
```
:::

::: tab [Verify]
```sh
pnpm verify:pr
```
:::

| Left column | Right column |
| :--- | ---: |
| **Ready** | `yes` |

<details><summary>More information</summary><p>Keep a rollback plan nearby.</p></details>
