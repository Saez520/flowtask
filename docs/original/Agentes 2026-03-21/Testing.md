# TESTING.md — eventos-qontalk

Guía técnica para agentes de IA responsables de crear y mantener tests en este codebase.

---

## 1. STACK DE TESTING

| Tecnología | Uso |
|---|---|
| JUnit 5 (Jupiter) | Framework de tests |
| Mockito 5 + `MockitoExtension` | Mocking y stubbing |
| `MockedStatic` (Mockito) | Mock de clases estáticas (`ClientContext`, `PropertiesManager`) |
| AssertJ | Assertions fluidas (usado en tests de repository) |
| JUnit Assertions | Assertions estándar (usado en tests de service y task) |
| MockWebServer (OkHttp) | Mock de servidores HTTP para tests de `OkHttpClientImpl` |
| Testcontainers | Disponible para tests de integración (PostgreSQL, MongoDB) — no usado aún |
| Jimfs | Sistema de archivos en memoria para tests — disponible |
| Spring Security Test | Tests de seguridad — disponible |

### Dependencias ya incluidas en `pom.xml`

```
spring-boot-starter-test (JUnit 5, Mockito, AssertJ)
spring-boot-testcontainers
spring-security-test
testcontainers:junit-jupiter
testcontainers:mongodb
testcontainers:postgresql
jimfs
mockwebserver (OkHttp)
```

> No es necesario agregar dependencias adicionales para la mayoría de tests.

---

## 2. ESTRUCTURA DE TESTS

### Ubicación base

```
src/test/java/co/com/quipux/eventosqontalk/
```

### Espejo de la estructura de producción

Los tests replican la estructura de paquetes del código fuente:

```
src/test/java/co/com/quipux/eventosqontalk/
  service/
    event/
      sending/
        impl/                       → Tests de EventSendingImpl
  manager/
    postgres/
      impl/                         → Tests de managers PostgreSQL
  repository/
    postgres/
      custom/
        impl/                       → Tests de Dao custom
  task/                             → Tests de tasks Quartz
  util/                             → Tests de utilidades (OkHttpClientImpl)
    task/                           → Tests adicionales de tasks
```

### Regla de ubicación

> El test de una clase en `src/main/.../paquete/Clase.java` se crea en `src/test/.../paquete/ClaseTest.java`, respetando la misma estructura de paquetes.

---

## 3. CONVENCIONES OBSERVADAS EN TESTS EXISTENTES

### Nombrado de clases de test

| Patrón | Ejemplo |
|---|---|
| `{ClaseOriginal}Test` | `ConsultaEventosTaskTest`, `OkHttpClientImplTest` |
| `{ClaseOriginal}{Funcionalidad}Test` | `EventSendingImplWorkerPoolTest`, `ProcesoEnvioManagerImplBulkUpdateTest` |

### Nombrado de métodos de test

Dos estilos coexisten. Usar el que predomine en la clase que se está testeando:

| Estilo | Ejemplo | Usado en |
|---|---|---|
| camelCase descriptivo | `debeProcessarEventosEnMultiplesLotes()` | `EventSendingImplTest` |
| snake_case con separador | `tipoProcedimientoAutomatico_debeRetornarConstanteCorrecta()` | Tasks tests |

> Ambos estilos son válidos. **Mantén consistencia dentro de la misma clase de test.**

### Estructura de cada test (AAA / Given-When-Then)

```java
@Test
void debeRetornarListaVaciaCuandoNoHayRegistros() {
    // Given
    List<Long> idsVacios = Collections.emptyList();

    // When
    int resultado = manager.bulkUpdateToEnviadoS(idsVacios);

    // Then
    assertEquals(0, resultado);
    verify(repository, never()).bulkUpdateToEnviadoS(any());
}
```

### Anotaciones obligatorias

| Anotación | Cuándo |
|---|---|
| `@ExtendWith(MockitoExtension.class)` | Siempre que uses `@Mock`, `@InjectMocks` |
| `@Mock` | Dependencias a mockear |
| `@InjectMocks` | Clase bajo test con inyección automática |
| `@BeforeEach` | Setup del test (inicializar mocks, crear instancias) |
| `@Test` | Cada método de test |
| `@DisplayName("...")` | Opcional, pero usado en tests con `@DisplayName` en clase |

### Configuración de Mockito

Archivo ya existente: `src/test/resources/mockito-extensions/` (vacío actualmente).

Cuando se necesite relajar strictness:

```java
@MockitoSettings(strictness = Strictness.LENIENT)
```

### Patrones de mock por capa

#### Controller — no testeado directamente
Los controllers actuales son delegadores simples. No existen tests de controller. [pendiente confirmar si se requieren]

#### Service impl

```java
@ExtendWith(MockitoExtension.class)
class MiServicioImplTest {

    @Mock
    private MiManager miManager;

    private MiServicioImpl servicio;

    @BeforeEach
    void setUp() {
        servicio = new MiServicioImpl(miManager);
    }
}
```

#### Manager impl

```java
@ExtendWith(MockitoExtension.class)
class MiManagerImplTest {

    @Mock
    private MiRepository miRepository;

    @InjectMocks
    private MiManagerImpl manager;
}
```

#### Task

```java
class MiTaskTest {

    private MiService miService;
    private CronProvider cronProvider;
    private MiTask task;

    @BeforeEach
    void setUp() {
        miService = mock(MiService.class);
        cronProvider = mock(CronProvider.class);
        task = new MiTask(miService, cronProvider);
    }
}
```

> Nota: Los tests de tasks usan `mock()` inline en lugar de `@Mock` + `@ExtendWith`. Ambos estilos son válidos.

#### Mock de clases estáticas (`ClientContext`, `PropertiesManager`)

```java
try (MockedStatic<ClientContext> mockedContext = mockStatic(ClientContext.class)) {
    mockedContext.when(ClientContext::getClient).thenReturn(CLIENTE_ID);
    // ... test logic
}
```

#### Mock de OkHttp con MockWebServer

```java
private MockWebServer mockWebServer;

@BeforeEach
void setUp() throws Exception {
    mockWebServer = new MockWebServer();
    mockWebServer.start();
}

@AfterEach
void tearDown() throws Exception {
    mockWebServer.shutdown();
}

@Test
void testRequest() {
    mockWebServer.enqueue(new MockResponse()
        .setBody("{\"message\": \"OK\"}")
        .setResponseCode(200));

    // usar mockWebServer.url("/path").toString() como URL
}
```

---

## 4. COBERTURA MÍNIMA

### Regla

> Todo código nuevo debe tener una cobertura de test mínima del **70%**.

### Qué medir

La cobertura del 70% aplica sobre **el código nuevo o modificado**, no sobre el total del proyecto. Se mide en:

- **Líneas de código** ejecutadas por los tests.
- **Ramas** (branches): cada `if`, `switch`, `ternario` debe tener al menos una rama cubierta.

### Qué testear por capa

| Capa | Qué testear | Prioridad |
|---|---|---|
| **Service impl** | Lógica de negocio, validaciones, flujos happy path y error | Alta |
| **Manager impl** | Delegación correcta al repository, transaccionalidad, manejo de vacíos/nulls | Media |
| **Task** | `executeTask()`, `tipoProcedimientoAutomatico()`, `getCronString()`, `getExecutionStrategy()` | Media |
| **Repository Dao impl** | Queries con parámetros correctos, paginación, mapeo de resultados | Media |
| **Util** | Métodos estáticos con lógica (parseo, validación, formateo) | Media |
| **Controller** | Solo si tiene lógica más allá de delegar al service | Baja |
| **Config** | Solo si contiene lógica condicional | Baja |
| **Entity / Document / DTO** | No testear getters/setters ni records | No aplica |

### Escenarios mínimos por servicio

Para alcanzar el 70%, cubre al menos:

1. **Happy path**: Flujo exitoso completo.
2. **Validación de entrada**: Parámetros nulos, vacíos, inválidos.
3. **Caso vacío**: Listas vacías, `Optional.empty()`.
4. **Excepción esperada**: `RequestException`, `Either.left()`.
5. **Edge case relevante**: Valores límite si aplica.

---

## 5. CHECKLIST — CREAR TESTS PARA CÓDIGO NUEVO

1. **Identifica las clases nuevas o modificadas** que necesitan tests.
2. **Lee el skill del servicio** en `src/docs/` si existe, para entender el flujo completo.
3. **Lee el código fuente** de la clase a testear y sus dependencias directas.
4. **Crea la clase de test** en la ruta espejo bajo `src/test/java/`, con sufijo `Test`.
5. **Configura el setup** con `@ExtendWith(MockitoExtension.class)`, `@Mock` para dependencias, e instanciación en `@BeforeEach`.
6. **Implementa tests** siguiendo la estructura Given-When-Then.
7. **Cubre al mínimo**: happy path, validaciones, caso vacío, excepción esperada.
8. **Ejecuta los tests** con `mvn test -pl . -Dtest=NombreClaseTest` para validar que pasan.
9. **Verifica cobertura** asegurando que el 70% de las líneas y ramas del código nuevo están cubiertas.

---

## 6. CHECKLIST — CREAR TESTS PARA CÓDIGO EXISTENTE

1. **Identifica la clase** y lee su código fuente completo.
2. **Verifica si ya existe un test** en la ruta espejo de `src/test/`.
3. **Si existe test**: agrega los métodos faltantes en la misma clase. No crees un archivo nuevo.
4. **Si no existe test**: crea la clase siguiendo el checklist de la sección 5.
5. **Respeta el estilo** del test existente (nombrado de métodos, assertions, patrón de mock).
6. **Ejecuta todos los tests** del módulo con `mvn test -DskipITs` para verificar que no hay regresión.

---

## 7. RESTRICCIONES

- **NUNCA modifiques código de producción** (`src/main/`) desde este agente. Este agente solo opera sobre `src/test/`.
- **NUNCA crees tests de integración** que requieran base de datos real o servicios externos levantados, a menos que se indique explícitamente.
- **NUNCA agregues dependencias al `pom.xml`**. Las dependencias de testing ya están incluidas.
- **NUNCA testees getters, setters, constructores triviales, records o DTOs** que no contengan lógica.
- **NUNCA escribas tests que dependan de orden de ejecución**. Cada test debe ser independiente.
- **NUNCA uses `Thread.sleep()` para sincronización** salvo en tests de concurrencia donde se mide paralelismo real (y con `CountDownLatch` como complemento).
- **NUNCA accedas a archivos de configuración reales** (`conf.properties`, `conf-eventos.properties`). Mockea `PropertiesManager` con `MockedStatic`.
- **NUNCA modifiques `AGENTS.md`**. Este agente no es responsable de la documentación de arquitectura.

---

## 8. REFERENCIA — TESTS EXISTENTES

### Archivos de test

| Archivo | Capa | Clase testeada |
|---|---|---|
| `service/event/sending/impl/EventSendingImplTest.java` | Service | `EventSendingImpl` — Batch processor |
| `service/event/sending/impl/EventSendingImplWorkerPoolTest.java` | Service | `EventSendingImpl` — Worker pool |
| `manager/postgres/impl/ProcesoEnvioManagerImplBulkUpdateTest.java` | Manager | `ProcesoEnvioManagerImpl` — Bulk updates |
| `repository/postgres/custom/impl/ProcesoEnvioDaoImplTest.java` | Repository | `ProcesoEnvioDaoImpl` — Query paginada |
| `task/ConsultaEventosTaskTest.java` | Task | `ConsultaEventosTask` |
| `util/task/EnviarEventosEmailTaskTest.java` | Task | `EnviarEventosEmailTask` |
| `util/task/ConsultarEventoYActaTaskTest.java` | Task | `ConsultarEventoYActaTask` |
| `util/task/EliminarLogsTaskTest.java` | Task | `EliminarLogsTask` |
| `util/task/EnviarEventoActaCertificadoTaskTest.java` | Task | `EnviarEventoActaCertificadoTask` |
| `util/OkHttpClientImplTest.java` | Util | `OkHttpClientImpl` — HTTP client |

### Documentación de tests

| Archivo | Descripción |
|---|---|
| `TESTS_CAPA_1.md` | Tests del batch processor (EventSendingImpl + ProcesoEnvioDaoImpl) |
| `TESTS_CAPA_2.md` | Tests del worker pool (EventSendingImpl concurrencia) |
| `TESTS_CAPA_3.md` | Tests de integración HTTP (OkHttpClientImpl + Bulk Updates) |

---

## 9. REFERENCIA — ARQUITECTURA DEL PROYECTO

Para entender la arquitectura de capas, convenciones, y restricciones del código de producción, consulta `AGENTS.md` en la raíz del proyecto. Las secciones relevantes para testing son:

- **Sección 1**: Stack y módulos — para saber qué clases existen en cada capa.
- **Sección 2**: Convenciones — para entender anotaciones, inyección, y nombrado.
- **Sección 3**: Obtención de propiedades — para saber qué mockear (`PropertiesManager`, `CronManager`).

