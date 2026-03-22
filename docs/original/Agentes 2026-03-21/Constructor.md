---
name: constructor
description: >-
  Implementa el plan generado por el planner siguiendo las convenciones
  del proyecto. Lee el plan desde .workspace/plan/PLAN_{ID}.md y ejecuta
  los artefactos en el orden especificado. No toma decisiones de diseño.
mode: subagent
hidden: true
permission:
  edit: allow
  bash: allow
---

# Constructor.md — eventos-qontalk

Guía técnica para agentes de IA que trabajen sobre este codebase.

---

## 1. STACK Y MÓDULOS

### Stack tecnológico

| Tecnología | Versión | Uso |
|---|---|---|
| Java | 21 | Lenguaje principal (virtual threads habilitados) |
| Spring Boot | 3.5.3 | Framework base |
| Spring Data JPA + Hibernate | — | Acceso a PostgreSQL |
| Spring Data MongoDB | — | Acceso a MongoDB / Amazon DocumentDB |
| Spring Security | — | Autenticación HTTP Basic |
| Quartz (Spring Starter) | — | Tareas programadas |
| OkHttp | 4.12.0 | Cliente HTTP para consumos REST |
| Resilience4j | 2.2.0 | Retry + Circuit Breaker sobre OkHttp |
| Bucket4j | 8.14.0 | Rate limiting para APIs externas (GSE) |
| Vavr | 0.10.4 | `Either`, `Try`, colecciones inmutables |
| Lombok | 1.18.34 | Reducción de boilerplate |
| Jackson YAML | 2.15.3 | Carga de queries SQL desde YAML |
| Maven | — | Build tool |
| Docker | Eclipse Temurin 21 JRE | Runtime en producción |

### Paquete raíz

```
co.com.quipux.eventosqontalk
```

### Arquitectura de capas (rutas reales)

```
controller/                         → Endpoints REST (@RestController)
service/                            → Interfaces de servicio
  impl/                             → Implementaciones de servicio (@Service)
  event/                            → Lógica de eventos (subdominios)
    reception/                      → Recepción de eventos de proveedores
      impl/                         → Implementaciones de recepción
    sending/                        → Envío de eventos a sistemas externos
      impl/                         → Implementaciones de envío
    fetching/                       → Consulta programada de eventos
      impl/                         → Implementaciones de consulta
    vendor/                         → Servicios por proveedor
      twilio/                       → TwilioService, TwilioEmailEventReception
      aldeamo/                      → AldeamoService, AldeamoEmailEventReception, AldeamoSmsEventReception
      indigitall/                   → IndigitallService, IndigitallSmsEventReception
  webhook/                          → Servicios de webhook SMS
  contact/provider/                 → Proveedores de contacto
  factory/                          → Fábricas de servicios (SistemaServiceFactory)
manager/                            → Capa intermedia entre service y repository
  postgres/                         → Interfaces de managers PostgreSQL
    impl/                           → Implementaciones (@Service)
  mongo/                            → Interfaces de managers MongoDB
    twilio/                         → Managers Twilio
    aldeamo/                        → Managers Aldeamo
    impl/                           → Implementaciones genéricas
    factory/                        → Fábricas de managers
repository/                         → Acceso a datos
  postgres/                         → JpaRepository + Dao custom
    custom/                         → Interfaces Dao
      impl/                         → Implementaciones SQL nativo (@Repository)
  mongo/                            → MongoRepository por proveedor
    twilio/                         → 11 colecciones Twilio
    aldeamo/                        → 6 colecciones Aldeamo
    gse/                            → 8 colecciones GSE
    indigitall/                     → 3 colecciones Indigitall
    custom/                         → Dao custom + EventosRepositoryImpl
model/
  entity/
    postgres/                       → @Entity JPA (sufijo Entity)
    mongo/                          → @Document MongoDB (sufijo Document)
      twilio/, aldeamo/, gse/, indigitall/
  dto/                              → DTOs de transferencia (sufijo Dto/DTO)
    request/                        → Request DTOs por proveedor
      twilio/, aldeamo/, gse/, indigitall/
    response/                       → Response DTOs
    gse/                            → DTOs específicos GSE
  projection/                       → Interfaces de proyección JPA
task/                               → Tareas programadas Quartz (extends QuartzTask)
strategy/                           → Patrón Strategy
  webhook/sms/                      → Strategies de webhook SMS
config/                             → Configuración Spring
  security/                         → WebSecurityConfig, JWT
  filter/                           → LoggingFilter (intercepta @WebServiceLogging)
  context/                          → ThreadLocal contexts (ClientContext, TaskExecutionContext)
  task/                             → QuartzTask base, TaskExecutionTarget
util/                               → Utilidades transversales
  annotation/                       → @WebServiceLogging
  constant/                         → Enums tipificados (TipoSistema, TipoOperador, ServicioPlataforma, etc.)
  exception/                        → Excepciones custom
  mapper/                           → Mappers (AldeamoDateMapper)
  concurrent/                       → Permits
```

### Dependencias entre capas

```
Controller → Service (interfaz)
Service impl → Manager (interfaz) + Repository (interfaz)
Manager impl → Repository
Task → Service / Manager (nunca Repository directo)
```

> **Excepción observada**: `EventosRepositoryImpl` usa `JdbcTemplate` + `MongoTemplate` directamente, sin pasar por managers. Este patrón existe solo en ese archivo y se usa para consultas de lectura cross-database.

---

## 2. CONVENCIONES

### Nombrado de clases

| Capa | Patrón | Ejemplo |
|---|---|---|
| Controller | `{Nombre}Controller` | `EventosController`, `TwilioController` |
| Service (interfaz) | `{Nombre}Service` o nombre descriptivo | `EventosService`, `EnviarEventoSistema`, `EventSending` |
| Service (impl) | `{Nombre}ServiceImpl` o `{Nombre}Impl` | `EventosServiceImpl`, `EnviarEventoSistemaImpl` |
| Manager (interfaz) | `{NombreEntidad}Manager` | `DatoGestionCampannaManager`, `TipoParametroManager` |
| Manager (impl) | `{NombreEntidad}ManagerImpl` | `DatoGestionCampannaManagerImpl` |
| Repository JPA | `{NombreEntidad}Repository` | `DatoGestionCampannaRepository` |
| Repository Dao | `{NombreEntidad}Dao` | `DatoGestionCampannaDao` |
| Repository Dao impl | En `custom/impl/` | — |
| Entity PostgreSQL | `{NombreTabla}Entity` | `DatoGestionCampannaEntity` |
| Document MongoDB | `{NombreColeccion}Document` | `TwilioCorreoEntregadoDocument` |
| Task | `{Nombre}Task` | `EnviarEventosEmailTask`, `ConsultaEventosTask` |
| DTO | `{Nombre}Dto` o `{Nombre}DTO` | `EnvioEventoDto`, `InfoEventoEmailDTO` |
| Request | `{Nombre}Request` | `ConsultarEventoRequest`, `EventoEmailTwilioRequest` |
| Response | `{Nombre}Response` | `EventosResponse`, `GenericExceptionResponse` |
| Excepción | `{Nombre}Exception` | `RequestException`, `HttpClientRequestException` |
| Enum tipificado | `Tipo{Nombre}` o nombre descriptivo | `TipoSistema`, `TipoOperador`, `ServicioPlataforma` |

### Anotaciones obligatorias por capa

| Capa | Anotación | Notas |
|---|---|---|
| Controller | `@RestController` | Puede incluir `@RequestMapping` para prefijo de ruta |
| Service impl | `@Service` | — |
| Manager impl | `@Service` | No usan `@Component`. Transacciones con `@Transactional` |
| Repository JPA | Extiende `JpaRepository` | Sin anotación explícita |
| Repository Dao impl | `@Repository` | Queries en SQL nativo via `SqlManager` |
| Repository Mongo | Extiende `MongoRepository` | Sin anotación explícita |
| Task | `@Service` + `@DisallowConcurrentExecution` | Extiende `QuartzTask` |
| Entity JPA | `@Entity` + `@Table` | — |
| Document Mongo | `@Document` | — |
| Config | `@Configuration` | — |

### Inyección de dependencias

- **Patrón dominante**: Inyección por constructor (sin `@Autowired` en el constructor).
- **Patrón secundario**: `@Autowired` en campos. Observado en `EventosServiceImpl` y `EventosRepositoryImpl`.
- **Lombok**: `@RequiredArgsConstructor` usado en algunos servicios (`ZenviaController`, `EnviarActaEntregaServiceImpl`, `AbstractEventFetchingService`).

### Logging

- `Logger` via `LoggerFactory.getLogger(ClaseActual.class)` o `@Slf4j` de Lombok.
- Prefijos observados: `S37:` en `EventosServiceImpl/EventosRepositoryImpl`, `[TIMER]`/`[TIMER-SERVICE]` para métricas, `[quartz.cronConsultarEvento]` en tasks.
- Tasks usan el nombre del cron como prefijo en logs: `"qontalk.enviarEventosEmail:"`, `"qontalk.eliminarLogs:"`.

### Manejo de errores en controllers

- `RequestException` para errores de negocio (400, 404).
- `ControllerExceptionHandler` (`@RestControllerAdvice`) captura globalmente.
- Errores genéricos devuelven `GenericExceptionResponse` con UUID de rastreo.

### Endpoints — Seguridad

- `/twilio/**`, `/aldeamo/**`, `/api/v1/zenvia/sms/events`, `/api/v1/status` → `permitAll()`
- Todo lo demás → `authenticated()` (HTTP Basic).
- Credenciales se obtienen de `PropertiesManager` (no `application.yml`).

### Programación funcional

- Uso extensivo de `Either<L, R>` (Vavr) para manejar éxito/error sin excepciones en servicios de envío.
- `Try.of()` para operaciones que pueden fallar en controllers.
- Colecciones inmutables de Vavr (`io.vavr.collection.List`) en `QuartzTask`.

### Tasks Quartz

Cada task extiende `QuartzTask` e implementa:

| Método | Descripción |
|---|---|
| `tipoProcedimientoAutomatico()` | ID del tipo de proceso (constante en `Constant.TipoProcedimientoAutomatico`) |
| `getCronString()` | Expresión cron via `cronProvider.getCron("clave")` |
| `getExecutionStrategy()` | `MULTITENANT`, `STANDALONE` o `QUERY_BASED` |
| `executeTask()` | Lógica de ejecución |
| `getExecutionTargets()` | Solo para `QUERY_BASED`, devuelve `List<TaskExecutionTarget>` |

### Importacion de clases
- NUNCA escribas el nombre completo del paquete inline en el código
  (ej. `co.com.quipux.eventosqontalk.util.exception.RequestException`).
- SIEMPRE usa el nombre corto de la clase en el código y agrega
  el `import` correspondiente al inicio del archivo.
---

## 3. OBTENCIÓN DE PROPIEDADES

### Clase responsable: `PropertiesManager`

- **Ubicación**: `co.com.quipux.eventosqontalk.util.PropertiesManager`
- **Tipo**: Clase final estática (no es un bean Spring, no se inyecta).
- **Archivos cargados** (en orden):
  1. `conf.properties` — Configuración general (BD, seguridad, servidor, URLs)
  2. `conf-eventos.properties` — Configuración de eventos y tasks

### Búsqueda de archivos (en orden de prioridad)

1. `/app/conf/` — Producción (Docker)
2. `/opt/eventos-qontalk/config/` — Desarrollo local
3. `./` — Fallback

### Uso correcto

```java
// Obtener propiedad obligatoria (lanza PropertyNotFoundException si no existe)
String valor = PropertiesManager.get("clave.propiedad");

// Obtener propiedad con tipo
Integer valor = PropertiesManager.get("clave.propiedad", Integer.class);

// Obtener propiedad opcional
Optional<String> valor = PropertiesManager.getOptional("clave.propiedad");
```

### Regla

> **El agente NUNCA debe acceder a propiedades de `conf.properties` o `conf-eventos.properties` usando `@Value`, `Environment` o cualquier otro mecanismo que no sea `PropertiesManager`.**
>
> **Excepción única**: `application.yml` sí usa `@Value` en `MongoConfig` para `spring.data.mongodb.uri` y `spring.data.mongodb.database`. Esta es la única propiedad que se obtiene por `@Value` porque es requerida por la autoconfiguración de Spring Boot.

### Otros gestores estáticos

| Clase | Archivo fuente | Uso |
|---|---|---|
| `CronManager` | `quartz-eventos.properties` | Expresiones cron. Acceder via `CronProvider` (bean). |
| `SqlManager` | `eventos-qontalk-sql.properties` | Queries SQL. Uso: `SqlManager.getQuery("archivo", "clave")` |
| `MessageManager` | `mensajes-eventos-qontalk.properties` | Mensajes i18n. Uso: `MessageManager.get("clave", args...)` |

---

## 4. CHECKLIST — MODIFICAR SERVICIO EXISTENTE

1. **Carga el skill del servicio** desde `src/docs/` antes de modificar cualquier archivo. Si no existe skill, analiza los archivos involucrados primero.
2. **Identifica la capa afectada** (controller, service, manager, repository, model).
3. **Lee los archivos actuales** de todas las capas que vas a tocar.
4. **Verifica las interfaces**: si modificas una implementación, confirma que la interfaz sea consistente.
5. **Respeta el patrón de inyección** existente en la clase (constructor vs `@Autowired` campo). No mezcles estilos dentro de la misma clase.
6. **Usa `PropertiesManager.get()`** para cualquier nueva propiedad de configuración externa.
7. **Registra logs** con el prefijo y formato consistente del servicio que modificas.
8. **Maneja errores** con `RequestException` para errores de negocio, `Either` para operaciones de envío.
9. **Verifica que compila** ejecutando `mvn compile -DskipTests`.
10. **Actualiza el skill** del servicio en `src/docs/` si el cambio altera el flujo, los endpoints, o el modelo de datos.

---

## 5. RESTRICCIONES

### Archivos protegidos

- **NUNCA modifiques `WebSecurityConfig.java`** sin confirmación explícita del usuario. Cambios pueden abrir o cerrar endpoints de forma no deseada.
- **NUNCA modifiques `MongoConfig.java`** sin confirmación explícita. Contiene configuración crítica de timeouts y SSL para Amazon DocumentDB.
- **NUNCA modifiques `QuartzTask.java`** sin confirmación explícita. Es la clase base de todas las tareas programadas; un error afecta todas las tasks.
- **NUNCA modifiques `ControllerExceptionHandler.java`** sin confirmación explícita. Cambios alteran el formato de respuesta de error global.
- **NUNCA modifiques `PropertiesManager.java`** sin confirmación explícita. Es el punto de acceso centralizado a toda la configuración externa.
- **NUNCA modifiques `OkHttpClientImpl.java`** sin confirmación explícita. Es el único cliente HTTP, con Resilience4j integrado.

### Archivos de configuración

- **NUNCA modifiques `application.yml`** para agregar propiedades de negocio. Solo contiene configuración de Spring Boot (virtual threads, resilience4j, security JWT). Las propiedades de negocio van en `conf.properties` o `conf-eventos.properties`.
- **NUNCA modifiques `pom.xml`** para agregar dependencias sin confirmación explícita.
- **NUNCA modifiques `Dockerfile`** o `docker-compose.yml` sin confirmación explícita.
- **NUNCA modifiques `logback-spring.xml`** o `logback.xml` sin confirmación explícita.

### Reglas de código

- **NUNCA uses `@Value`** para inyectar propiedades de `conf.properties`. Usa `PropertiesManager.get()`.
- **NUNCA accedas a un `Repository` directamente desde un `Controller`**. Pasa por `Service` → `Manager` → `Repository`.
- **NUNCA crees una task Quartz sin `@DisallowConcurrentExecution`**, a menos que se justifique explícitamente.
- **NUNCA lances excepciones checked desde un service**. Usa `RequestException` para errores de negocio o `Either` para operaciones que pueden fallar.
- **NUNCA escribas queries inline en el código Java** (ni como Strings concatenados ni como constantes en la clase). Todas las queries SQL deben definirse en `eventos-qontalk-sql.properties` y obtenerse con `SqlManager.getQuery("eventos-qontalk-sql.properties", "clave")`.
- **NUNCA crees archivos de test** (`src/test/`). Este agente no es responsable de la generación de pruebas unitarias, de integración ni de ningún otro tipo de test.

---

## 6. DOCUMENTACIÓN TÉCNICA Y SKILLS DISPONIBLES

### Skills de servicios
Ubicación: `src/docs/skills/`
Carga el skill correspondiente antes de modificar cualquier servicio.

| Archivo | Cuándo cargarlo |
|---|---|
| `service/consultar-eventos/SKILL.md` | Al tocar la versión 1 del servicio |
| `service/consultar-eventos-v2/SKILL.md` | Al tocar la versión 2 del servicio |
| `task/consultar-eventos/SKILL.md` | Al tocar la task de consulta de eventos |

### Skills de arquitectura
Ubicación: `src/docs/arquitectura/`

| Archivo | Cuándo cargarlo |
|---|---|
| `checklist_crear_servicio.md` | Al crear cualquier artefacto nuevo |

## 7. WORKSPACE

Directorio: `.workspace/` 

### Flujo obligatorio

1. El usuario escribe el requisito en `.workspace/CA/CA-{ID}.md`
2. El planner lee ese archivo, genera el plan y lo escribe en
   `.workspace/plan/PLAN_{ID}.md`. No responde en el chat.
3. El usuario revisa `.workspace/plan/PLAN_{ID}.md` y confirma.
4. El agente de implementación lee el plan desde disco y ejecuta.

### Convención de IDs
Usar el identificador del CA para los archivos del plan.