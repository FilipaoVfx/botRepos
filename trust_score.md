# Trust Score — Filosofía e Implementación por Fases

Add comment
Commenting on line 2
Cancel
Comment
## Filosofía

El Trust Score es un sistema de puntuación que mide la **calidad y confiabilidad** de un repositorio de GitHub basado en señales de interacción real de la comunidad. No se trata solo de estrellas o popularidad técnica, sino del **impacto genuino** que un repo genera en su audiencia.

La premisa es simple: un repo compartido en Twitter que genera muchas interacciones (likes, saves, replies, reposts) es un repo que **resuena** con su comunidad. Cuanto más interactúa la gente, más confianza merece.

### Señales (v3 — métricas EN VIVO del post padre vía scraper.tech)

v3 recalibra v2: v2 usaba divisores lineales con techos de tweet viral (1000
likes / 500k views / 10% engagement / 10 menciones), así que 3 de 5 cubos
quedaban casi vacíos siempre y todo se apelmazaba en 2–6. v3 usa escala
**logarítmica** en volumen y anclas realistas.

| Señal | Peso | Normalización | Por qué |
|---|---|---|---|
| `avg_likes` | 30% | `log10(1+x)/log10(1+1000)` | Aprobación directa (1k likes ≈ tope) |
| `avg_saves` | 22% | `log10(1+x)/log10(1+800)` | Intención de volver — más valioso que un like |
| `engagement_rate` | 25% | `min(rate/6, 1)` | % real de interacción (6% ≈ tope realista). Mide **conexión** |
| `avg_impressions` | 13% | `log10(1+x)/log10(1+300000)` | Alcance bruto como señal de distribución |
| `mentions_count` | 10% | `min(mentions/3, 1)` | Reincidencia — repo posteado en varios tweets |

`engagement_rate = interacciones / impresiones × 100` (fracción real; v2 arregló
el % saturado del CSV). Autor no verificado: ×0.97.

### Fórmula (v3)

```
logN(x, a) = min( log10(1+x) / log10(1+a), 1 )

trust_score = 10 × (
  0.30 × logN(likes,    1000) +
  0.22 × logN(saves,     800) +
  0.25 × min(engagement_rate / 6, 1) +
  0.13 × logN(impressions, 300000) +
  0.10 × min(mentions / 3, 1)
) × (verified ? 1 : 0.97)   → escala 0.00–10.00
```

La fórmula vive en un único sitio: `computeTrustScore()` en `rag-orchestrator.js`
(la usan el import de CSV y el refresco en vivo). `TRUST_SCORE_VERSION` la versiona;
al subirla, las filas viejas se marcan stale y se recomputan al abrir el detail.

### Interpretación (v3)

| Rango | Significado |
|---|---|
| 8-10 | Repos masivos, altamente validados |
| 6-8 | Repos con buena tracción comunitaria |
| 4-6 | Repos sólidos, audiencia moderada |
| 2-4 | Repos nicho, poca interacción |
| 0-2 | Sin datos de interacción aún |

---

## Respaldo GitHub (cuando no hay métricas de X)

Solo los repos cuyo post padre tiene métricas de X (vía scraper.tech) tienen el
Trust Score "de comunidad". Para el resto se calcula un puntaje de respaldo con
señales de GitHub, leídas de `github_repositories` (stars, forks, `pushed_at`),
la tabla de metadatos que mantiene el indexer.

```
logN(x, a) = min( log10(1+x) / log10(1+a), 1 )
actividad  = 1 si el último push fue hace ≤ 90 días; baja lineal hasta 0 a los 2 años

github_score = 10 × ( 0.60 × logN(stars, 200000)
                    + 0.20 × logN(forks,  50000)
                    + 0.20 × actividad )  × (archivado ? 0.5 : 1)
```

- La fórmula vive en `computeGithubScore()` de `rag-orchestrator.js` y se versiona
  con `GITHUB_SCORE_VERSION`. Se calcula al leer, así que no se guarda.
- Calibración (2026-10-08): las anclas se eligieron para que la escala quede cerca
  de la de X. En los 403 repos da p50 ≈ 6.8 y p90 ≈ 8.9; en los 26 con métricas de
  X, el puntaje de X da p50 7.6 y p90 8.6.
- **Puntaje efectivo:** se usa el de X si existe; si no, el de GitHub. El bot
  muestra el origen en la insignia (`· X` o `· GH`) y el detalle del repo muestra
  el desglose de ambas fuentes.
- **Refresco:** `scripts/backfill-trust.js --stale-only` corre en cada ingesta
  (`TRUST_REFRESH_LIMIT` repos por fuente). GitHub se considera vencido a las
  12 h (`STARS_TTL_MS`) y X a los 7 días (`TRUST_X_TTL_DAYS`). Al abrir el detalle
  de un repo, el bot también refresca en segundo plano lo que esté vencido.
- **Backfill completo de X** (cuesta créditos de scraper.tech, una llamada por
  post padre, ~430 en total):
  `node scripts/backfill-trust.js --source=x --dry-run` y luego sin `--dry-run`.

---

## Implementación por Fases

### Fase 0: Base de datos de métricas (YA)

Archivos generados desde el CSV de Twitter Analytics:
- `github_repos_metrics.csv` — trust score agregado por repo
- `github_repos_enriched.csv` — métricas por tweet individual

**Estado:** Completado. 255 repos con métricas de interacción.

---

### Fase 1: Almacenamiento en Supabase

**Objetivo:** Persistir las métricas de interacción en una tabla dedicada para poder consultarlas desde cualquier punto del sistema.

#### 1.1 Nueva tabla SQL

```sql
CREATE TABLE public.repo_engagement_metrics (
  repo_slug TEXT PRIMARY KEY REFERENCES public.github_repo_readmes(repo_slug) ON DELETE CASCADE,
  -- Métricas del CSV
  source_url TEXT NOT NULL,                -- tweet padre
  mentions_count INT DEFAULT 1,
  avg_likes NUMERIC(10,2) DEFAULT 0,
  avg_impressions NUMERIC(12,2) DEFAULT 0,
  avg_interactions NUMERIC(12,2) DEFAULT 0,
  avg_saves NUMERIC(10,2) DEFAULT 0,
  avg_shares NUMERIC(10,2) DEFAULT 0,
  avg_replies NUMERIC(10,2) DEFAULT 0,
  avg_reposts NUMERIC(10,2) DEFAULT 0,
  avg_profile_visits NUMERIC(10,2) DEFAULT 0,
  avg_url_clicks NUMERIC(10,2) DEFAULT 0,
  avg_engagement_rate NUMERIC(5,2) DEFAULT 0,
  avg_like_rate NUMERIC(5,2) DEFAULT 0,
  -- Trust score
  trust_score NUMERIC(4,2) DEFAULT 0,       -- 0.00 - 10.00
  trust_score_version INT DEFAULT 1,        -- para tracking de cambios en la fórmula
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_repo_engagement_trust_score ON public.repo_engagement_metrics(trust_score DESC);
```

#### 1.2 Script de migración

```
backend/sql/016_repo_engagement_metrics.sql
```

Script Node.js para importar desde CSV:
```
backend/scripts/import-engagement-metrics.js
```

#### 1.3 Funciones helper en `rag-orchestrator.js`
