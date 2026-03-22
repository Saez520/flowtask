---
description: Scan and index only repository/data-access layer into Engram
agent: flowtask-initializer
subtask: true
---
Scan the repository/data-access layer of this project:

1. Detect file types:
   - Look for files that interact with databases or external data sources
   - Common extensions: .java, .ts, .py, .go, .cs, .php, .sql, .rb

2. Identify data-access directories:
   - Look for directories with names like: repository, repo, dao, data, db, persistence, dal, accessor, datastore

3. Identify data access patterns:
   - ORM usage: JPA, Hibernate, TypeORM, Prisma, SQLAlchemy, GORM, Eloquent, Sequelize
   - Query builders: QueryDSL, JOOQ, Knex, Prisma Client
   - Raw queries: SQL files, query strings in code
   - Migration tools: Flyway, Liquibase, Knex migrations, Prisma migrations
   - Connection patterns: connection pools, transaction management

4. Extract data access conventions:
   - Naming patterns for repository/dao classes
   - Method naming conventions (findBy, getBy, create, update, delete, etc.)
   - Query storage patterns (inline, separate files, annotations)
   - Transaction handling patterns

5. Save to Engram:
   - mem_save(type: pattern, topic_key: project/repositories, title: "Data access patterns")
   - mem_save(type: config, topic_key: project/stack) if database technology detected
   - Use mem_suggest_topic_key before saving

6. Report what was detected and saved.
