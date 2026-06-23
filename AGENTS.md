# AGENTS.md - Eduard Anfragen

Diese Datei ist Pflichtkontext fuer Coding-Agents in diesem Repo.

## Branch-Regeln
- `main`: nur via PR oder explizitem GO des Users.
- Jedes Feature: eigener Branch `feature/[name]`.
- Kein Push auf `main` ohne vorherigen "Kein Deploy ohne GO"-Check.
- Kein Deploy ohne explizites GO des Users.
- Wenn lokale Commits auf `main` liegen, vor Push/Deploy erst `git log --oneline origin/main..HEAD` zeigen und bestaetigen lassen.

## Datenmodell (Kurzreferenz)
- `offer_run`: `{ id, status, raw_email_body, kalkulation_anfrage, kalkulation_lager, hat_match, top_lager_name, upsell_daten, kunde_* }`
- Status-Flow: `pending -> sent_to_owner -> sent_to_customer | rejected`
- Review-relevante Felder: `draft_html`, `draft_subject`, `customer_json`, `line_items_json`, `pricing_json`, `match_json`, `owner_feedback`.
- Mail-Quelle: je nach Eingangskanal Gmail, Replay oder IMAP; Provider-IDs duerfen fuer Dedup/Readiness nicht blind als fachliche Duplikate gewertet werden.
