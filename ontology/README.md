# Ontology fragments

Type declarations that are **data, not code**. Load one into a database with:

```bash
yoke ontology add-type ontology/catalog.json
```

Nothing here is seeded by `yoke init`, deliberately. The seed is what every yoke database needs; a
fragment is what some organisations need, and a knowledge database should not presume that every tenant
runs services. Adding one changes no code, and `yoke ontology list` afterwards shows it beside the
seeded types with no distinction — which is the point of the ontology being data.

## catalog.json — what the org runs (v7.3)

`service`, `api`, `datastore`, and `depends_on`. The portal's screens (`yoke catalog`, `/catalog`) work
over these, and `yoke connect backstage` fills them from `catalog-info.yaml` descriptors the
organisation already maintains.

**They carry a TTL, and that is the point.** A descriptor is only as fresh as its last PR, so a
service record ages past 180 days and appears in `yoke review --stale` addressed to its owner. A
catalog that cannot go stale is the one that quietly lies; this is the axis a descriptor-driven portal
has no way to show.

`name` is declared on each because every surface that shows one of these shows its name, and the
ontology-driven create form offers exactly the declared fields. `lifecycle` is a free string rather
than an enum — production/experimental/deprecated is one org's vocabulary, and the ontology is per
database.
