# Collecteur OpenTelemetry de l'API Blame

Ce dossier fournit le point d'entrée OTLP de la surveillance de l'API hébergée de Blame (`blame-api`) : traces HTTP et base de données, métriques runtime Node et HTTP, durées des phases des Cloud Previews et logs d'erreur du serveur. L'application Desktop n'envoie rien ici. Le Collector retire les données interdites, normalise les conventions historiques, limite la cardinalité, applique le tail sampling et transmet les trois signaux à un backend OTLP distinct.

Le Collector est une seconde barrière. L'API filtre déjà ses attributs avant l'envoi (`packages/api/app/lib/monitoring`) : pas de credentials, de corps de requête, d'URL complète, de requête SQL ni de message d'erreur libre. Un texte libre arbitraire ne peut pas être classifié de façon fiable par le Collector.

## Démarrage

Depuis ce dossier :

```sh
cp .env.example .env
chmod 600 .env
```

Renseigner au minimum :

- `BLAME_OTEL_BACKEND_ENDPOINT`, sous la forme `hôte:port` d'un endpoint OTLP/gRPC ;
- `BLAME_OTEL_BACKEND_AUTHORIZATION`, avec la valeur complète de l'en-tête, par exemple `Bearer …` ;
- `BLAME_OTEL_BACKEND_INSECURE=false` pour conserver TLS.

Valider puis démarrer :

```sh
docker compose config
docker compose run --rm --no-deps otel-collector validate --config=/etc/otelcol-contrib/config.yaml
docker compose up -d
curl --fail http://127.0.0.1:13133/health
curl --fail http://127.0.0.1:8888/metrics
```

L'image `otel/opentelemetry-collector-contrib` est épinglée à `0.156.0`. Toute montée de version doit passer par la commande de validation et un envoi de test des trois signaux.

## Connexion de l'API

L'API n'exporte rien tant que `OTEL_EXPORTER_OTLP_ENDPOINT` n'est pas défini ; `OTEL_SDK_DISABLED=true` coupe l'export. Pour une API exécutée sur le même hôte :

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Pour une API située sur le même réseau Docker, utiliser le nom de service :

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Les ports OTLP/gRPC `4317`, OTLP/HTTP `4318`, santé `13133` et métriques internes `8888` sont liés à `127.0.0.1` par défaut. Une exposition distante exige un réseau privé ou une terminaison TLS avec authentification devant les receivers. Ne pas publier ces ports directement sur Internet.

Le backend est volontairement configuré avec d'autres variables que l'API. `OTEL_EXPORTER_OTLP_ENDPOINT` désigne le Collector depuis l'API, tandis que `BLAME_OTEL_BACKEND_ENDPOINT` désigne le backend depuis le Collector. Cette séparation empêche une boucle d'export.

## Traitement des signaux

Les traces suivent l'ordre :

```text
OTLP → memory limiter → redaction → normalisation → suppression défensive → filtre → tail sampling → batch → backend
```

Les logs suivent le même ordre sans sampling. Seuls les événements structurés dont le nom respecte le namespace `blame.*`, comme `blame.http.request.failed`, sont admis et leur corps est remplacé par ce nom stable. Les métriques portant un identifiant utilisateur ou de session, un chemin de fichier ou un message d'erreur sont rejetées avant redaction, car retirer cette dimension pourrait fusionner deux séries distinctes. Les autres attributs métriques sont filtrés par une allowlist bornée.

Les attributs de ressource sont limités à ceux que l'API émet : service, environnement, SDK, runtime, système, architecture et région cloud.

La redaction conserve les conventions sémantiques HTTP, base de données et erreur. Elle bloque notamment les clés ou valeurs ressemblant à des credentials, tokens Bearer, clés API, JWT, mots de passe et URLs contenant des credentials. Les requêtes SQL et les noms de spans associés sont assainis. Les URLs contenant des segments variables sont supprimées ou assainies sans écraser les noms conventionnels des spans.

Les métriques propres à l'API, `blame.runtime.phase.count` et `blame.runtime.phase.duration`, portent seulement `blame.runtime.name`, `blame.runtime.phase` et `blame.operation.status`.

Les instrumentations HTTP et MySQL émettent encore certains noms historiques ; le Collector les ramène aux conventions retenues :

| Historique         | Convention                  |
| ------------------ | --------------------------- |
| `http.method`      | `http.request.method`       |
| `http.status_code` | `http.response.status_code` |
| `db.system`        | `db.system.name`            |
| `net.peer.name`    | `server.address`            |
| `net.peer.port`    | `server.port`               |

## Tail sampling

La politique garde :

- 100 % des traces comportant un span au statut `ERROR`, un `error.type` ou un statut HTTP 5xx ;
- 100 % des traces plus lentes que `BLAME_OTEL_SLOW_TRACE_THRESHOLD_MS`, dix secondes par défaut ;
- `BLAME_OTEL_ROLLOUT_SAMPLING_PERCENTAGE` des traces de la version indiquée par `BLAME_OTEL_ROLLOUT_VERSION` ;
- `BLAME_OTEL_NORMAL_SAMPLING_PERCENTAGE` des traces des autres versions.

La cohorte normale exclut explicitement la version en rollout. Les probabilités ne se cumulent donc pas. La valeur `disabled` désactive de fait la cohorte rollout tant qu'aucun service n'utilise cette version.

`BLAME_OTEL_TAIL_DECISION_WAIT` vaut deux minutes par défaut, au-delà des requêtes HTTP les plus longues de l'API. Après réception du root span, le Collector attend encore `BLAME_OTEL_TAIL_ROOT_GRACE_PERIOD`. Augmenter la fenêtre si une requête légitime peut la dépasser.

La capacité minimale de `BLAME_OTEL_TAIL_NUM_TRACES` doit couvrir approximativement :

```text
nouveaux_traces_par_seconde × fenêtre_de_décision_en_secondes
```

Contrôler simultanément la mémoire, `BLAME_OTEL_EXPECTED_NEW_TRACES_PER_SEC`, les traces abandonnées et les spans tardifs. Le conteneur dispose par défaut de 1 Gio, le memory limiter intervient à 768 Mio et Go cible 896 Mio. Toute modification de `BLAME_OTEL_CONTAINER_MEMORY_LIMIT`, `BLAME_OTEL_GO_MEMORY_LIMIT`, `BLAME_OTEL_MEMORY_LIMIT_MIB` ou `BLAME_OTEL_MEMORY_SPIKE_LIMIT_MIB` doit préserver cet ordre et une marge suffisante pour le runtime.

Avec plusieurs Collectors, toutes les données d'un même trace ID doivent atteindre la même instance. Mettre un répartiteur compatible avec l'affinité par trace ID devant les Collectors. Une répartition aléatoire fragmente les traces et invalide le tail sampling.

## Fiabilité et sécurité

La file d'export est persistée dans le volume `otel-collector-storage`. Elle absorbe une indisponibilité temporaire du backend et survit au remplacement du conteneur. Elle ne constitue ni une sauvegarde ni une politique de rétention. Le backend doit appliquer sa propre rétention, son contrôle d'accès et son chiffrement.

Le buffer du tail sampling reste en mémoire et n'est pas couvert par cette file persistante. Les déploiements du Collector doivent donc être drainés proprement et surveiller les traces en attente ou tardives.

Le service d'initialisation du stockage ne possède que la capacité `CHOWN`, termine avant le démarrage du Collector et prépare le volume pour l'UID non-root `10001`. Le Collector fonctionne ensuite sans capacité Linux, avec un système de fichiers racine en lecture seule.

Le fichier `.env` contient un credential d'export et doit rester non versionné, limité à l'identité d'exploitation et fourni par un gestionnaire de secrets en production. La vérification TLS est active. `BLAME_OTEL_BACKEND_INSECURE=true` ne convient qu'à un backend local sur un réseau de confiance.

Les logs du Collector sont encodés en JSON. Ils décrivent le pipeline et ses erreurs, pas les événements reçus. Les métriques internes sont exposées au format Prometheus sur `/metrics`. Relier les alertes à cet endpoint et surveiller au minimum les refus mémoire, échecs d'export, files pleines, erreurs de traitement, décisions de sampling et spans tardifs.

Les événements de facturation ne doivent pas dépendre de ce pipeline. Les traces sont échantillonnées et les buffers ont une capacité finie ; les événements durables restent dans la base de données de l'API.

## Validation hors Docker Compose

La configuration exige ses variables au moment de la validation :

```sh
set -a
. ./.env
set +a
otelcol-contrib validate --config=otel-collector.yaml
```

Après chaque modification, envoyer une trace en erreur, une trace lente, une trace normale, une métrique avec `user.id` et un log contenant un faux token. Vérifier respectivement la conservation, l'échantillonnage, le rejet de la métrique et l'absence du token côté backend.
