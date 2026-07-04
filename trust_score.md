# Trust Score — Filosofía e Implementación por Fases

Add comment
Commenting on line 2
Cancel
Comment
## Filosofía

El Trust Score es un sistema de puntuación que mide la **calidad y confiabilidad** de un repositorio de GitHub basado en señales de interacción real de la comunidad. No se trata solo de estrellas o popularidad técnica, sino del **impacto genuino** que un repo genera en su audiencia.

La premisa es simple: un repo compartido en Twitter que genera muchas interacciones (likes, saves, replies, reposts) es un repo que **resuena** con su comunidad. Cuanto más interactúa la gente, más confianza merece.

### Señales actuales (CSV de Twitter Analytics)

| Señal | Peso actual | Por qué |
|---|---|---|
| `avg_likes` (normalizado a /50) | 25% | Aprobación directa de la audiencia |
| `avg_saves` (normalizado a /10) | 20% | Intención de volver — más valioso que un like |
| `engagement_rate` (×10, cap 10) | 25% | Qué % de quienes vieron el tweet interactuaron. Mide **conexión real** |
| `total_mentions` (cap 10) | 15% | Consistencia — si el repo se menciona múltiples veces, hay reincidencia |
| `avg_impressions` (normalizado a /5000) | 15% | Alcance bruto como señal de distribución |

### Fórmula

```
trust_score = (
  min(likes_avg / 50, 10) × 0.25 +
  min(saves_avg / 10, 10) × 0.20 +
  min(mentions_count, 10) × 0.15 +
  min(engagement_rate × 10, 10) × 0.25 +
  min(impressions_avg / 5000, 10) × 0.15
) / 10 × 10  → escala 0-10
```

### Interpretación

| Rango | Significado |
|---|---|
| 8-10 | Repos masivos, altamente validados |
| 6-8 | Repos con buena tracción comunitaria |
| 4-6 | Repos sólidos, audiencia moderada |
| 2-4 | Repos nicho, poca interacción |
| 0-2 | Sin datos de interacción aún |

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
