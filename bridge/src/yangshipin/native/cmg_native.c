
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define strtok_r strtok_s
#define strdup _strdup
#else
#include <pthread.h>
#include <sys/time.h>
#endif
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cmg_wasm.h"
#include "cmg_memory_init.h"
#include "wasm-rt.h"
#include "wasm-rt-impl.h"

#define LOGI(...) do {} while(0)
#define LOGW(...) do {} while(0)
#define LOGE(...) fprintf(stderr, __VA_ARGS__)

#define CMG_INITIAL_PAGES 256u
#define CMG_MAX_PAGES 1536u
#define CMG_TABLE_SIZE 560u
#define CMG_TABLE_BASE 0u
#define CMG_TEMP_DOUBLE_PTR 17920u
#define CMG_DYNAMIC_TOP_PTR 17904u
#define CMG_EMT_STACK_TOP 6309392u
#define CMG_EMBIND_STORAGE 6309392u
#define CMG_DYNAMIC_TOP_AFTER_SHELL_ALLOCATIONS 6687984u
#define CMG_MEMORY_EXTEND 2048u
#define CMG_PLAYER_MEMORY_EXTEND 1968u
#define CMG_NAL_MEMORY_EXTEND CMG_MEMORY_EXTEND
#define CMG_LOCATION_ORIGIN "https://www.yangshipin.cn"
#define CMG_LOCATION_HREF "https://www.yangshipin.cn/tv/home"
#define CMG_PAGE_HOST CMG_LOCATION_ORIGIN

typedef enum cmg_emval_type {
  CMG_EMVAL_EMPTY,
  CMG_EMVAL_LOCATION,
  CMG_EMVAL_STRING,
  CMG_EMVAL_DESTRUCTORS
} cmg_emval_type;

typedef struct cmg_emval_handle {
  cmg_emval_type type;
  int refcount;
  char* text;
  u32 destructor_address;
} cmg_emval_handle;

#if defined(_WIN32)
static SRWLOCK g_lock = SRWLOCK_INIT;
static void cmg_mutex_lock(void) {
    AcquireSRWLockExclusive(&g_lock);
}
static void cmg_mutex_unlock(void) {
    ReleaseSRWLockExclusive(&g_lock);
}
#else
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static void cmg_mutex_lock(void) {
    pthread_mutex_lock(&g_lock);
}
static void cmg_mutex_unlock(void) {
    pthread_mutex_unlock(&g_lock);
}
#endif
static int g_initialized;
static wasm_rt_memory_t g_memory;
static wasm_rt_table_t g_table;
static u32 g_table_base = CMG_TABLE_BASE;
static u32 g_temp_double_ptr = CMG_TEMP_DOUBLE_PTR;
static u32 g_dynamic_top_ptr = CMG_DYNAMIC_TOP_PTR;
static u32 g_emt_stack_top = CMG_EMT_STACK_TOP;
static u32 g_embind_storage = CMG_EMBIND_STORAGE;
static u32 g_temp_ret0;
static char g_player_tag[32];
static char g_forced_player_tag[32];
static char g_forced_location_href[256];
static int g_player_active;
static int g_player_init_trap;
static u32 g_player_init_result;
static u32 g_update_tag;
static u32 g_logged_update_tag;
static uint64_t g_forced_clock_ms;
static cmg_emval_handle g_emval_handles[64];
static u32 g_emval_free_list[64];
static size_t g_emval_free_count;
static u32 g_emval_handle_count;
static int g_location_property_reads;
static const char* g_trace_phase = "idle";
static int g_env_read_log_count;
static int g_import_log_count;
static int g_update_call_log_count;
static int g_heap_log_count;
static u32 g_decode_data_address;
static u32 g_decode_data_capacity;
static u32 g_decode_tag_address;
static u32 g_decode_tag_capacity;

u32 (*Z_envZ___table_baseZ_i) = &g_table_base;
u32 (*Z_envZ_aZ_i) = &g_temp_double_ptr;
u32 (*Z_envZ_bZ_i) = &g_dynamic_top_ptr;
u32 (*Z_envZ_cZ_i) = &g_emt_stack_top;
u32 (*Z_envZ_dZ_i) = &g_embind_storage;
wasm_rt_memory_t (*Z_envZ_memory) = &g_memory;
wasm_rt_table_t (*Z_envZ_table) = &g_table;

static uint8_t* cmg_pointer(u32 address, size_t size) {
  if ((uint64_t) address + size > g_memory.size) {
    return NULL;
  }
  return g_memory.data + address;
}

static u32 cmg_dynamic_top(void) {
  uint32_t* top = (uint32_t*) cmg_pointer(CMG_DYNAMIC_TOP_PTR, sizeof(uint32_t));
  return top == NULL ? 0 : *top;
}

static void cmg_set_dynamic_top(u32 value) {
  uint32_t* top = (uint32_t*) cmg_pointer(CMG_DYNAMIC_TOP_PTR, sizeof(uint32_t));
  if (top != NULL) {
    *top = value;
  }
}

static int cmg_apply_memory_init(void) {
  size_t relocation_index;
  if (CMG_EMBIND_STORAGE + sizeof(CMG_MEMORY_INIT) > g_memory.size) {
    LOGE("CMG memory init too large: storage=%u payload=%u memory=%u",
        CMG_EMBIND_STORAGE, (u32) sizeof(CMG_MEMORY_INIT), (u32) g_memory.size);
    return 0;
  }
  memcpy(g_memory.data + CMG_EMBIND_STORAGE, CMG_MEMORY_INIT, sizeof(CMG_MEMORY_INIT));
  for (relocation_index = 0;
      relocation_index < sizeof(CMG_MEMORY_RELOCATIONS) / sizeof(CMG_MEMORY_RELOCATIONS[0]);
      relocation_index++) {
    uint32_t* target = (uint32_t*) cmg_pointer(
        CMG_EMBIND_STORAGE + CMG_MEMORY_RELOCATIONS[relocation_index], sizeof(uint32_t));
    if (target == NULL) {
      return 0;
    }
    *target += CMG_EMBIND_STORAGE;
  }
  ((u32*) (g_memory.data + CMG_DYNAMIC_TOP_PTR))[0] = CMG_DYNAMIC_TOP_AFTER_SHELL_ALLOCATIONS;
  return 1;
}

static u32 cmg_strlen(u32 address) {
  u32 length = 0;
  while (address + length < g_memory.size && g_memory.data[address + length] != 0) {
    length++;
  }
  return length;
}

static void cmg_reset_emval_state(void) {
  u32 handle;
  for (handle = 5; handle < g_emval_handle_count; handle++) {
    free(g_emval_handles[handle].text);
  }
  memset(g_emval_handles, 0, sizeof(g_emval_handles));
  memset(g_emval_free_list, 0, sizeof(g_emval_free_list));
  g_emval_handles[1].type = CMG_EMVAL_LOCATION;
  g_emval_free_count = 0;
  g_emval_handle_count = 5;
  g_location_property_reads = 0;
}

static u32 cmg_allocate_emval_handle(void) {
  u32 handle;
  if (g_emval_free_count > 0) {
    handle = g_emval_free_list[--g_emval_free_count];
  } else {
    if (g_emval_handle_count >= sizeof(g_emval_handles) / sizeof(g_emval_handles[0])) {
      return 1;
    }
    handle = g_emval_handle_count++;
  }
  memset(&g_emval_handles[handle], 0, sizeof(g_emval_handles[handle]));
  g_emval_handles[handle].refcount = 1;
  return handle;
}

static u32 cmg_register_emval_string(const char* text, size_t length) {
  u32 handle = cmg_allocate_emval_handle();
  if (handle <= 4) {
    return handle;
  }
  g_emval_handles[handle].text = (char*) malloc(length + 1);
  if (g_emval_handles[handle].text == NULL) {
    return 1;
  }
  memcpy(g_emval_handles[handle].text, text, length);
  g_emval_handles[handle].text[length] = '\0';
  g_emval_handles[handle].type = CMG_EMVAL_STRING;
  return handle;
}

static u32 cmg_register_emval_destructors(void) {
  u32 handle = cmg_allocate_emval_handle();
  if (handle > 4) {
    g_emval_handles[handle].type = CMG_EMVAL_DESTRUCTORS;
  }
  return handle;
}

static u32 cmg_register_emval_location(void) {
  u32 handle = cmg_allocate_emval_handle();
  if (handle > 4) {
    g_emval_handles[handle].type = CMG_EMVAL_LOCATION;
  }
  return handle;
}

static void cmg_release_emval_handle(u32 handle) {
  if (handle <= 4 || handle >= g_emval_handle_count || g_emval_handles[handle].refcount == 0) {
    return;
  }
  if (--g_emval_handles[handle].refcount == 0) {
    free(g_emval_handles[handle].text);
    memset(&g_emval_handles[handle], 0, sizeof(g_emval_handles[handle]));
    if (g_emval_free_count < sizeof(g_emval_free_list) / sizeof(g_emval_free_list[0])) {
      g_emval_free_list[g_emval_free_count++] = handle;
    }
  }
}

static u32 cmg_write_string(const char* text) {
  size_t length = strlen(text) + 1;
  u32 address = (*Z_CaZ_ii)((u32) length);
  uint8_t* target = cmg_pointer(address, length);
  if (target != NULL) {
    memcpy(target, text, length);
  }
  return address;
}

static u32 cmg_write_padded_string(const char* text, u32 extra) {
  size_t length = strlen(text);
  size_t total = length + 1u + extra;
  u32 address = (*Z_CaZ_ii)((u32) total);
  uint8_t* target = cmg_pointer(address, total);
  if (target != NULL) {
    memset(target, 0, total);
    memcpy(target, text, length);
  }
  return address;
}

static u32 cmg_write_tag_buffer(const char* text, u32 extra, int clear_buffer) {
  size_t length = strlen(text);
  size_t total = length + (size_t) extra;
  u32 address = (*Z_CaZ_ii)((u32) total);
  uint8_t* target = cmg_pointer(address, total);
  if (target != NULL) {
    if (clear_buffer) {
      memset(target, 0, total);
    }
    memcpy(target, text, length);
  }
  return address;
}

static u32 cmg_update_player_with_fresh_tag(void) {
  const char* previous_phase = g_trace_phase;
  u32 tag_address;
  u32 update_tag = 0;
  int should_log = g_update_call_log_count < 24;
  /* hls.cmg.js clears the complete tag + MemoryExtend allocation before
   * copying mediaTagId. UpdatePlayer reads beyond the string terminator. */
  tag_address = cmg_write_tag_buffer(g_player_tag, CMG_MEMORY_EXTEND, 1);
  g_trace_phase = "update";
  if (should_log) {
    LOGI("CMG UpdatePlayer begin tagAddr=%u size=%u top=%u g6=%u g7=%u g9=%u",
        tag_address, (u32) (strlen(g_player_tag) + CMG_MEMORY_EXTEND),
        cmg_dynamic_top(), cmg_debug_get_g6(), cmg_debug_get_g7(), cmg_debug_get_g9());
  }
  if (cmg_pointer(tag_address, strlen(g_player_tag) + CMG_MEMORY_EXTEND) != NULL) {
    update_tag = (*Z_daZ_ii)(tag_address);
  }
  if (should_log || update_tag != g_logged_update_tag) {
    LOGI("CMG UpdatePlayer end result=%08x top=%u g6=%u g7=%u g9=%u",
        update_tag, cmg_dynamic_top(), cmg_debug_get_g6(), cmg_debug_get_g7(),
        cmg_debug_get_g9());
  }
  if (tag_address != 0) {
    (*Z_BaZ_vi)(tag_address);
  }
  if (should_log) {
    LOGI("CMG UpdatePlayer free tagAddr=%u top=%u", tag_address, cmg_dynamic_top());
  }
  g_update_call_log_count++;
  g_trace_phase = previous_phase;
  return update_tag;
}

static u32 cmg_return_js_string(const char* text) {
  size_t length = strlen(text) + 1;
  size_t total = length;
  u32 address = (*Z_EaZ_ii)((u32) total);
  uint8_t* target = cmg_pointer(address, total);
  if (target != NULL) {
    memset(target, 0, total);
    memcpy(target, text, length);
  }
  return address;
}

typedef u32 (*cmg_decode_function)(u32, u32, u32, u32);

static int cmg_should_run_decode_step(u32 update_tag, int index) {
  int shift = (7 - index) * 4;
  u32 digit = (update_tag >> shift) & 0x0fu;
  return digit <= 6u;
}

static const char* cmg_emval_text(u32 handle) {
  if (handle == 1) {
    return CMG_LOCATION_HREF;
  }
  if (handle < g_emval_handle_count && g_emval_handles[handle].text != NULL) {
    return g_emval_handles[handle].text;
  }
  return "";
}

static const char* cmg_location_href(void) {
  return g_forced_location_href[0] != '\0' ? g_forced_location_href : CMG_LOCATION_HREF;
}

static void cmg_log_env_read(const char* api, const char* name, const char* value) {
  if (g_env_read_log_count < 48) {
    LOGI("CMG env %s phase=%s %s -> %s",
        api, g_trace_phase, name == NULL ? "(null)" : name, value == NULL ? "(null)" : value);
    g_env_read_log_count++;
  }
}

static int cmg_should_log_import(void) {
  return g_import_log_count < 96
      && strcmp(g_trace_phase, "idle") != 0;
}

static void cmg_log_import(const char* api, const char* format, ...) {
  va_list args;
  char message[512];
  if (!cmg_should_log_import()) {
    return;
  }
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  LOGI("CMG import %s phase=%s top=%u g6=%u g7=%u g9=%u %s",
      api, g_trace_phase, cmg_dynamic_top(), cmg_debug_get_g6(),
      cmg_debug_get_g7(), cmg_debug_get_g9(), message);
  g_import_log_count++;
}

static void cmg_hex_bytes(u32 address, size_t size, char* output, size_t output_size) {
  size_t i;
  uint8_t* bytes;
  size_t limit;
  if (output_size == 0) {
    return;
  }
  output[0] = '\0';
  bytes = cmg_pointer(address, size);
  if (bytes == NULL) {
    return;
  }
  limit = size;
  if (limit > (output_size - 1) / 2) {
    limit = (output_size - 1) / 2;
  }
  for (i = 0; i < limit; i++) {
    snprintf(output + i * 2, output_size - i * 2, "%02x", bytes[i]);
  }
}

static u32 cmg_u32_at(u32 address) {
  uint32_t* value = (uint32_t*) cmg_pointer(address, sizeof(uint32_t));
  return value == NULL ? 0u : *value;
}

static void cmg_log_heap_snapshot(const char* label) {
  char stack_a[129];
  char stack_b[129];
  char heap_a[193];
  if (g_heap_log_count >= 48 || strcmp(g_trace_phase, "init") != 0) {
    return;
  }
  cmg_hex_bytes(18336u, 64, stack_a, sizeof(stack_a));
  cmg_hex_bytes(18656u, 64, stack_b, sizeof(stack_b));
  cmg_hex_bytes(6691728u, 96, heap_a, sizeof(heap_a));
  LOGI("CMG heap %s top=%u g6=%u g7=%u g9=%u s18336=%s s18656=%s h6691728=%s",
      label, cmg_dynamic_top(), cmg_debug_get_g6(), cmg_debug_get_g7(),
      cmg_debug_get_g9(), stack_a, stack_b, heap_a);
  g_heap_log_count++;
}

static uint64_t cmg_now_ms64(void) {
  if (g_forced_clock_ms != 0u) {
    return g_forced_clock_ms;
  }
#if defined(_WIN32)
  FILETIME ft;
  ULARGE_INTEGER li;
  GetSystemTimeAsFileTime(&ft);
  li.LowPart = ft.dwLowDateTime;
  li.HighPart = ft.dwHighDateTime;
  return (uint64_t) ((li.QuadPart - 116444736000000000ULL) / 10000ULL);
#else
  struct timeval now;
  gettimeofday(&now, NULL);
  return (uint64_t) now.tv_sec * 1000u + (uint64_t) now.tv_usec / 1000u;
#endif
}

static u32 env_now_ms(void) {
  return (u32) cmg_now_ms64();
}

static void cmg_make_player_tag(void) {
  uint64_t millis;
  if (g_forced_player_tag[0] != '\0') {
    snprintf(g_player_tag, sizeof(g_player_tag), "%s", g_forced_player_tag);
    return;
  }
  millis = cmg_now_ms64();
  snprintf(g_player_tag, sizeof(g_player_tag), "%llu", (unsigned long long) millis);
}

static u32 import_e(void) { return g_temp_ret0; }
static void import_f(u32 value) { g_temp_ret0 = value; }
static u32 import_g(u32 timeval_address, u32 timezone_address) {
  uint64_t millis;
  uint8_t* target;
  (void) timezone_address;
  millis = cmg_now_ms64();
  target = cmg_pointer(timeval_address, 8);
  if (target == NULL) {
    return (u32) -1;
  }
  ((u32*) target)[0] = (u32) (millis / 1000u);
  ((u32*) target)[1] = (u32) ((millis % 1000u) * 1000u);
  return 0;
}
static void import_h(u32 a, u32 b, u32 c, u32 d, u32 e) {
  (void) a; (void) b; (void) c; (void) d; (void) e;
}
static f64 import_i(void) {
  return (f64) cmg_now_ms64();
}
static void import_j(void) { LOGE("CMG pure virtual call"); wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE); }
static void import_k(u32 a, u32 b) { (void) a; (void) b; }
static void import_l(u32 a) { (void) a; }
static u32 import_m(u32 a, u32 b, u32 c, u32 d, u32 e) {
  (void) a; (void) b; (void) c; (void) d; (void) e; return 0;
}
static u32 import_n(u32 a, u32 b, u32 c, u32 d) {
  (void) a; (void) b; (void) c; (void) d; return 0;
}
static u32 import_o(u32 requested_size) {
  LOGE("CMG cannot grow memory to %u", requested_size);
  wasm_rt_trap(WASM_RT_TRAP_EXHAUSTION);
  return 0;
}
static u32 cmg_memmove(u32 destination, u32 source, u32 size) {
  uint8_t* destination_pointer = cmg_pointer(destination, size);
  uint8_t* source_pointer = cmg_pointer(source, size);
  if (destination_pointer != NULL && source_pointer != NULL) {
    memmove(destination_pointer, source_pointer, size);
  }
  return destination;
}
static u32 import_p(u32 function_index, u32 a, u32 b) {
  (void) function_index; (void) a; (void) b; return 0;
}
static void import_q(void) { LOGE("CMG llvm trap"); wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE); }
static void import_r(u32 a) { (void) a; }
static u32 import_s(u32 requested_size) {
  uint64_t current_pages = g_memory.pages;
  uint64_t requested_pages = ((uint64_t) requested_size + 65535u) / 65536u;
  if (requested_pages <= current_pages) {
    return 1;
  }
  return wasm_rt_grow_memory(&g_memory, requested_pages - current_pages) == (u32) -1 ? 0 : 1;
}
static u32 import_t(u32 destination, u32 source, u32 size) {
  return cmg_memmove(destination, source, size);
}
static void import_u(u32 flags, u32 message) {
  const char* text = (const char*) cmg_pointer(message, 1);
  (void) flags;
  if (text != NULL) {
    LOGI("%s", text);
  }
}
static u32 import_v(void) { return 1; }
static u32 import_w(void) { return g_memory.size; }
static u32 import_x(u32 flags, u32 buffer, u32 size) {
  (void) flags; (void) buffer; (void) size; return 0;
}
static u32 import_y(u32 a, u32 b, f64 c, u32 d, u32 e, u32 f, u32 g) {
  (void) a; (void) b; (void) c; (void) d; (void) e; (void) f; (void) g; return 0;
}
static u32 import_z(u32 operation, u32 argument) {
  const char* name = (const char*) cmg_pointer(argument, 1);
  (void) operation;
  if (name == NULL) {
    return 0;
  }
  if (strcmp(name, "self.location.href") == 0) {
    cmg_log_env_read("z", name, cmg_location_href());
    return cmg_return_js_string(cmg_location_href());
  }
  if (strcmp(name, "self.location.origin") == 0) {
    cmg_log_env_read("z", name, CMG_LOCATION_ORIGIN);
    return cmg_return_js_string(CMG_LOCATION_ORIGIN);
  }
  if (strcmp(name, "self.location.host") == 0) {
    cmg_log_env_read("z", name, "www.yangshipin.cn");
    return cmg_return_js_string("www.yangshipin.cn");
  }
  if (strcmp(name, "self.location.protocol") == 0) {
    cmg_log_env_read("z", name, "https:");
    return cmg_return_js_string("https:");
  }
  if (strcmp(name, "location.href") == 0) {
    cmg_log_env_read("z", name, cmg_location_href());
    return cmg_return_js_string(cmg_location_href());
  }
  if (strcmp(name, "location.origin") == 0) {
    cmg_log_env_read("z", name, CMG_LOCATION_ORIGIN);
    return cmg_return_js_string(CMG_LOCATION_ORIGIN);
  }
  if (strcmp(name, "location.host") == 0) {
    cmg_log_env_read("z", name, "www.yangshipin.cn");
    return cmg_return_js_string("www.yangshipin.cn");
  }
  if (strcmp(name, "location.protocol") == 0) {
    cmg_log_env_read("z", name, "https:");
    return cmg_return_js_string("https:");
  }
  cmg_log_env_read("z", name, "");
  return cmg_return_js_string("");
}
static void import_A(void) { LOGE("CMG abort"); wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE); }
static u32 import_B(u32 type, u32 value_address) {
  uint32_t* length_pointer;
  uint8_t* text;
  u32 result;
  uint8_t* raw;
  u32 string_address = value_address;
  (void) type;
  raw = cmg_pointer(value_address, 32);
  if (raw != NULL) {
    uint32_t candidate = ((uint32_t*) raw)[0];
    uint8_t* candidate_bytes = cmg_pointer(candidate, 32);
    if (candidate_bytes != NULL) {
      string_address = candidate;
    }
  }
  length_pointer = (uint32_t*) cmg_pointer(string_address, sizeof(uint32_t));
  if (length_pointer == NULL) {
    cmg_log_import("B", "type=%u value=%u string=%u missing-length",
        type, value_address, string_address);
    return 1;
  }
  if (*length_pointer > 4096u) {
    cmg_log_import("B", "type=%u value=%u string=%u bad-length=%u",
        type, value_address, string_address, *length_pointer);
    return 1;
  }
  text = cmg_pointer(string_address + 4, *length_pointer);
  if (text == NULL) {
    cmg_log_import("B", "type=%u value=%u string=%u length=%u missing-text",
        type, value_address, string_address, *length_pointer);
    return 1;
  }
  result = cmg_register_emval_string((const char*) text, *length_pointer);
  cmg_log_import("B", "type=%u value=%u string=%u length=%u -> handle=%u text=%s",
      type, value_address, string_address, *length_pointer, result,
      result <= 4 ? "(failed)" : g_emval_handles[result].text);
  cmg_log_heap_snapshot("after-B");
  return result;
}
static void import_C(u32 destructors) {
  u32 destructor_address = destructors < g_emval_handle_count
      ? g_emval_handles[destructors].destructor_address : 0;
  cmg_log_import("C", "destructors=%u type=%u destructorAddr=%u",
      destructors,
      destructors < g_emval_handle_count ? (u32) g_emval_handles[destructors].type : 0,
      destructor_address);
  cmg_log_heap_snapshot("before-C");
  if (destructors > 4 && destructors < g_emval_handle_count
      && g_emval_handles[destructors].type == CMG_EMVAL_DESTRUCTORS) {
    if (destructor_address != 0) {
      (*Z_AaZ_vi)(destructor_address);
    }
    cmg_release_emval_handle(destructors);
  }
  cmg_log_heap_snapshot("after-C");
}
static u32 import_D(u32 object, u32 property_handle) {
  const char* property = property_handle < g_emval_handle_count
      ? g_emval_handles[property_handle].text : NULL;
  int is_location = object == 1 || (object < g_emval_handle_count
      && g_emval_handles[object].type == CMG_EMVAL_LOCATION);
  if (is_location && property != NULL) {
    if (strcmp(property, "href") == 0) {
      cmg_log_env_read("D", property, cmg_location_href());
      return cmg_register_emval_string(cmg_location_href(), strlen(cmg_location_href()));
    }
    if (strcmp(property, "origin") == 0) {
      cmg_log_env_read("D", property, CMG_LOCATION_ORIGIN);
      return cmg_register_emval_string(CMG_LOCATION_ORIGIN, strlen(CMG_LOCATION_ORIGIN));
    }
    if (strcmp(property, "host") == 0) {
      cmg_log_env_read("D", property, "www.yangshipin.cn");
      return cmg_register_emval_string("www.yangshipin.cn", strlen("www.yangshipin.cn"));
    }
    if (strcmp(property, "protocol") == 0) {
      cmg_log_env_read("D", property, "https:");
      return cmg_register_emval_string("https:", strlen("https:"));
    }
  }
  if (is_location) {
    g_location_property_reads++;
    if (g_location_property_reads == 1) {
      cmg_log_env_read("D", "(fallback-1)", CMG_LOCATION_ORIGIN);
      return cmg_register_emval_string(CMG_LOCATION_ORIGIN, strlen(CMG_LOCATION_ORIGIN));
    }
    if (g_location_property_reads == 2) {
      cmg_log_env_read("D", "(fallback-2)", cmg_location_href());
      return cmg_register_emval_string(cmg_location_href(), strlen(cmg_location_href()));
    }
    cmg_log_env_read("D", "(fallback-n)", "https:");
    return cmg_register_emval_string("https:", strlen("https:"));
  }
  cmg_log_env_read("D", property, "(handle-1)");
  return 1;
}
static u32 import_E(u32 name_address) {
  const char* name = (const char*) cmg_pointer(name_address, 1);
  if (name != NULL && (strcmp(name, "location") == 0 || strcmp(name, "self") == 0)) {
    u32 handle = cmg_register_emval_location();
    cmg_log_import("E", "nameAddr=%u name=%s -> handle=%u",
        name_address, name, handle);
    return handle;
  }
  cmg_log_import("E", "nameAddr=%u name=%s -> handle=1",
      name_address, name == NULL ? "(null)" : name);
  return 1;
}
static void import_F(u32 handle) {
  cmg_emval_type type = handle < g_emval_handle_count ? g_emval_handles[handle].type : CMG_EMVAL_EMPTY;
  cmg_log_import("F", "handle=%u type=%u ref=%d text=%s",
      handle,
      (u32) type,
      handle < g_emval_handle_count ? g_emval_handles[handle].refcount : 0,
      (handle < g_emval_handle_count && g_emval_handles[handle].text != NULL)
          ? g_emval_handles[handle].text : "");
  cmg_release_emval_handle(handle);
  cmg_log_heap_snapshot("after-F");
}
static f64 import_G(u32 handle, u32 return_type, u32 destructors_address) {
  const char* text = cmg_emval_text(handle);
  size_t length = strlen(text);
  u32 destructors = cmg_register_emval_destructors();
  u32 result;
  uint32_t* pointer;
  uint8_t* output;
  u32 destructors_before;
  char destructors_hex_before[33];
  char destructors_hex_after[33];
  char result_hex_before[129];
  char result_hex[129];
  (void) return_type;
  destructors_before = cmg_u32_at(destructors_address);
  cmg_hex_bytes(destructors_address, 16, destructors_hex_before, sizeof(destructors_hex_before));
  cmg_hex_bytes(destructors_before, 64, result_hex_before, sizeof(result_hex_before));
  pointer = (uint32_t*) cmg_pointer(destructors_address, sizeof(uint32_t));
  if (pointer == NULL) {
    cmg_log_import("G", "handle=%u returnType=%u destructorsAddr=%u missing-destructors text=%s",
        handle, return_type, destructors_address, text);
    return 0.0;
  }
  result = (*Z_EaZ_ii)((u32) length + 5);
  *pointer = destructors;
  pointer = (uint32_t*) cmg_pointer(result, sizeof(uint32_t));
  if (pointer == NULL) {
    cmg_log_import("G", "handle=%u returnType=%u destructors=%u result=%u missing-length text=%s",
        handle, return_type, destructors, result, text);
    return 0.0;
  }
  *pointer = (uint32_t) length;
  output = cmg_pointer(result + 4, length + 1);
  if (output == NULL) {
    cmg_log_import("G", "handle=%u returnType=%u destructors=%u result=%u length=%u missing-output text=%s",
        handle, return_type, destructors, result, (u32) length, text);
    return 0.0;
  }
  memcpy(output, text, length + 1);
  if (destructors > 4) {
    g_emval_handles[destructors].destructor_address = result;
  }
  cmg_hex_bytes(destructors_address, 16, destructors_hex_after, sizeof(destructors_hex_after));
  cmg_hex_bytes(result, 64, result_hex, sizeof(result_hex));
  cmg_log_import("G",
      "handle=%u returnType=%u destructorsAddr=%u d0=%u dh0=%s rbh=%s destructors=%u d1=%u dh1=%s result=%u r0=%u rh=%s length=%u text=%s",
      handle, return_type, destructors_address, destructors_before, destructors_hex_before, result_hex_before,
      destructors, cmg_u32_at(destructors_address), destructors_hex_after, result,
      cmg_u32_at(result), result_hex, (u32) length, text);
  cmg_log_heap_snapshot("after-G");
  return (f64) result;
}
static void import_H(u32 a) { (void) a; }
static u32 import_I(u32 a, u32 b) { (void) a; (void) b; return 0; }
static void import_J(u32 a, u32 b) { (void) a; (void) b; }
static void import_K(u32 a, u32 b, u32 c) { (void) a; (void) b; (void) c; }
static void import_L(u32 a, u32 b) { (void) a; (void) b; }
static void import_M(u32 a, u32 b, u32 c) { (void) a; (void) b; (void) c; }
static void import_N(u32 a, u32 b, u32 c, u32 d, u32 e) {
  (void) a; (void) b; (void) c; (void) d; (void) e;
}
static void import_O(u32 a, u32 b, u32 c) { (void) a; (void) b; (void) c; }
static void import_P(u32 a, u32 b) { (void) a; (void) b; }
static void import_Q(u32 a, u32 b, u32 c, u32 d, u32 e) {
  (void) a; (void) b; (void) c; (void) d; (void) e;
}
static u32 import_R(u32 a, u32 b) { (void) a; (void) b; return (u32) -1; }
static u32 import_S(u32 a, u32 b) { (void) a; (void) b; return (u32) -1; }
static u32 import_T(u32 a, u32 b) { (void) a; (void) b; return (u32) -1; }
static void import_U(u32 a) { (void) a; }
static u32 import_V(void) { return 0; }
static u32 import_W(u32 a) { (void) a; return 0; }
static void import_X(u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g) {
  (void) a; (void) b; (void) c; (void) d; (void) e; (void) f; (void) g;
}
static void import_Y(u32 a, u32 b, u32 c, u32 d, u32 e, u32 f) {
  (void) a; (void) b; (void) c; (void) d; (void) e; (void) f;
}
static void import_Z(u32 a, u32 b, u32 c, u32 d, u32 e) {
  (void) a; (void) b; (void) c; (void) d; (void) e;
}
static void import_(u32 a, u32 b, u32 c, u32 d) { (void) a; (void) b; (void) c; (void) d; }
static void import_dollar(u32 a, u32 b, u32 c) { (void) a; (void) b; (void) c; }
static void import_aa(u32 message) {
  uint8_t* text = cmg_pointer(message, 1);
  LOGE("CMG abort: %s", text != NULL ? (const char*) text : "");
  wasm_rt_trap(WASM_RT_TRAP_UNREACHABLE);
}

u32 (*Z_envZ_eZ_iv)(void) = import_e;
void (*Z_envZ_fZ_vi)(u32) = import_f;
u32 (*Z_envZ_gZ_iii)(u32, u32) = import_g;
void (*Z_envZ_hZ_viiiii)(u32, u32, u32, u32, u32) = import_h;
f64 (*Z_envZ_iZ_dv)(void) = import_i;
void (*Z_envZ_jZ_vv)(void) = import_j;
void (*Z_envZ_kZ_vii)(u32, u32) = import_k;
void (*Z_envZ_lZ_vi)(u32) = import_l;
u32 (*Z_envZ_mZ_iiiiii)(u32, u32, u32, u32, u32) = import_m;
u32 (*Z_envZ_nZ_iiiii)(u32, u32, u32, u32) = import_n;
u32 (*Z_envZ_oZ_ii)(u32) = import_o;
u32 (*Z_envZ_pZ_iiii)(u32, u32, u32) = import_p;
void (*Z_envZ_qZ_vv)(void) = import_q;
void (*Z_envZ_rZ_vi)(u32) = import_r;
u32 (*Z_envZ_sZ_ii)(u32) = import_s;
u32 (*Z_envZ_tZ_iiii)(u32, u32, u32) = import_t;
void (*Z_envZ_uZ_vii)(u32, u32) = import_u;
u32 (*Z_envZ_vZ_iv)(void) = import_v;
u32 (*Z_envZ_wZ_iv)(void) = import_w;
u32 (*Z_envZ_xZ_iiii)(u32, u32, u32) = import_x;
u32 (*Z_envZ_yZ_iiidiiii)(u32, u32, f64, u32, u32, u32, u32) = import_y;
u32 (*Z_envZ_zZ_iii)(u32, u32) = import_z;
void (*Z_envZ_AZ_vv)(void) = import_A;
u32 (*Z_envZ_BZ_iii)(u32, u32) = import_B;
void (*Z_envZ_CZ_vi)(u32) = import_C;
u32 (*Z_envZ_DZ_iii)(u32, u32) = import_D;
u32 (*Z_envZ_EZ_ii)(u32) = import_E;
void (*Z_envZ_FZ_vi)(u32) = import_F;
f64 (*Z_envZ_GZ_diii)(u32, u32, u32) = import_G;
void (*Z_envZ_HZ_vi)(u32) = import_H;
u32 (*Z_envZ_IZ_iii)(u32, u32) = import_I;
void (*Z_envZ_JZ_vii)(u32, u32) = import_J;
void (*Z_envZ_KZ_viii)(u32, u32, u32) = import_K;
void (*Z_envZ_LZ_vii)(u32, u32) = import_L;
void (*Z_envZ_MZ_viii)(u32, u32, u32) = import_M;
void (*Z_envZ_NZ_viiiii)(u32, u32, u32, u32, u32) = import_N;
void (*Z_envZ_OZ_viii)(u32, u32, u32) = import_O;
void (*Z_envZ_PZ_vii)(u32, u32) = import_P;
void (*Z_envZ_QZ_viiiii)(u32, u32, u32, u32, u32) = import_Q;
u32 (*Z_envZ_RZ_iii)(u32, u32) = import_R;
u32 (*Z_envZ_SZ_iii)(u32, u32) = import_S;
u32 (*Z_envZ_TZ_iii)(u32, u32) = import_T;
void (*Z_envZ_UZ_vi)(u32) = import_U;
u32 (*Z_envZ_VZ_iv)(void) = import_V;
u32 (*Z_envZ_WZ_ii)(u32) = import_W;
void (*Z_envZ_XZ_viiiiiii)(u32, u32, u32, u32, u32, u32, u32) = import_X;
void (*Z_envZ_YZ_viiiiii)(u32, u32, u32, u32, u32, u32) = import_Y;
void (*Z_envZ_Z5AZ_viiiii)(u32, u32, u32, u32, u32) = import_Z;
void (*Z_envZ__Z_viiii)(u32, u32, u32, u32) = import_;
void (*Z_envZ_Z24Z_viii)(u32, u32, u32) = import_dollar;
void (*Z_envZ_aaZ_vi)(u32) = import_aa;

static int cmg_init_locked(void) {
  int trap;
  if (g_initialized) {
    return 1;
  }
  LOGI("CMG init: allocate memory/table");
  wasm_rt_allocate_memory(&g_memory, CMG_INITIAL_PAGES, CMG_MAX_PAGES);
  wasm_rt_allocate_table(&g_table, CMG_TABLE_SIZE, CMG_TABLE_SIZE);
  cmg_reset_emval_state();
  memset(g_memory.data, 0, g_memory.size);
  if (!cmg_apply_memory_init()) {
    LOGE("CMG memory init failed");
    return 0;
  }
  trap = wasm_rt_impl_try();
  if (trap != 0) {
    LOGE("CMG wasm init trapped: %d", trap);
    return 0;
  }
  LOGI("CMG init: generated init begin");
  init();
  ((u32*) (g_memory.data + CMG_DYNAMIC_TOP_PTR))[0] = CMG_DYNAMIC_TOP_AFTER_SHELL_ALLOCATIONS;
  LOGI("CMG init: global constructors");
  (*Z_LaZ_vv)();
  ((u32*) (g_memory.data + CMG_DYNAMIC_TOP_PTR))[0] = CMG_DYNAMIC_TOP_AFTER_SHELL_ALLOCATIONS;
  cmg_make_player_tag();
  LOGI("CMG init: activate player tag %s", g_player_tag);
  u32 init_tag_address = cmg_write_tag_buffer(g_player_tag, CMG_MEMORY_EXTEND, 1);
  LOGI("CMG init: activate player tagAddr=%u size=%u",
      init_tag_address, (u32) (strlen(g_player_tag) + CMG_MEMORY_EXTEND));
  g_player_init_trap = wasm_rt_impl_try();
  if (g_player_init_trap == 0) {
    g_trace_phase = "init";
    LOGI("CMG InitPlayer begin tagAddr=%u top=%u", init_tag_address, cmg_dynamic_top());
    g_player_init_result = (*Z_baZ_ii)(init_tag_address);
    LOGI("CMG InitPlayer end result=%08x top=%u", g_player_init_result, cmg_dynamic_top());
    g_trace_phase = "idle";
    LOGI("CMG InitPlayer result=%08x clock=%llu",
        g_player_init_result, (unsigned long long) cmg_now_ms64());
    g_player_active = 1;
  } else {
    LOGE("CMG InitPlayer trapped: %d", g_player_init_trap);
    g_player_active = 1;
  }
  if (init_tag_address != 0) {
    (*Z_BaZ_vi)(init_tag_address);
    LOGI("CMG InitPlayer free tagAddr=%u top=%u", init_tag_address, cmg_dynamic_top());
  }
  g_initialized = 1;
  LOGI("CMG wasm runtime initialized");
  return 1;
}

static void cmg_reset_runtime_locked(void) {
  u32 handle;
  if (g_memory.data != NULL) {
    free(g_memory.data);
  }
  if (g_table.data != NULL) {
    free(g_table.data);
  }
  for (handle = 5; handle < g_emval_handle_count; handle++) {
    free(g_emval_handles[handle].text);
  }
  memset(&g_memory, 0, sizeof(g_memory));
  memset(&g_table, 0, sizeof(g_table));
  memset(g_player_tag, 0, sizeof(g_player_tag));
  memset(g_emval_handles, 0, sizeof(g_emval_handles));
  memset(g_emval_free_list, 0, sizeof(g_emval_free_list));
  g_initialized = 0;
  g_player_active = 0;
  g_player_init_trap = 0;
  g_player_init_result = 0;
  g_update_tag = 0;
  g_logged_update_tag = 0;
  g_emval_free_count = 0;
  g_emval_handle_count = 0;
  g_location_property_reads = 0;
  g_decode_data_address = 0;
  g_decode_data_capacity = 0;
  g_decode_tag_address = 0;
  g_decode_tag_capacity = 0;
  g_trace_phase = "idle";
}

static int cmg_parse_trace_update_delta(const char* update_trace, int wanted_index, uint64_t* delta) {
  char* copy;
  char* save;
  char* token;
  int index = 0;
  if (delta == NULL) {
    return 0;
  }
  *delta = 0u;
  if (update_trace == NULL || update_trace[0] == '\0') {
    return 0;
  }
  copy = strdup(update_trace);
  if (copy == NULL) {
    return 0;
  }
  token = strtok_r(copy, ";", &save);
  while (token != NULL) {
    if (index == wanted_index) {
      char* comma = strchr(token, ',');
      if (comma != NULL) {
        *comma = '\0';
      }
      *delta = (uint64_t) strtoull(token, NULL, 10);
      free(copy);
      return 1;
    }
    index++;
    token = strtok_r(NULL, ";", &save);
  }
  free(copy);
  return 0;
}

typedef struct cmg_replay_alloc {
  u32 official;
  u32 actual;
} cmg_replay_alloc;

static u32 cmg_replay_lookup_alloc(cmg_replay_alloc* allocs, int count, u32 official) {
  int i;
  for (i = count - 1; i >= 0; i--) {
    if (allocs[i].official == official) {
      return allocs[i].actual;
    }
  }
  return 0u;
}

static void cmg_replay_remove_alloc(cmg_replay_alloc* allocs, int* count, u32 official) {
  int i;
  if (allocs == NULL || count == NULL) {
    return;
  }
  for (i = *count - 1; i >= 0; i--) {
    if (allocs[i].official == official) {
      int j;
      for (j = i; j + 1 < *count; j++) {
        allocs[j] = allocs[j + 1];
      }
      (*count)--;
      return;
    }
  }
}

static int cmg_trace_starts_with(const char* text, const char* prefix) {
  return text != NULL && strncmp(text, prefix, strlen(prefix)) == 0;
}

static u32 cmg_parse_event_number(const char* event, const char* marker) {
  const char* start;
  if (event == NULL || marker == NULL) {
    return 0u;
  }
  start = strstr(event, marker);
  if (start == NULL) {
    return 0u;
  }
  start += strlen(marker);
  return (u32) strtoul(start, NULL, 10);
}

static u32 cmg_replay_official_trace_locked(const char* native_trace,
    const char* update_trace, uint64_t update_base_time_ms, int clock_offset_ms) {
  char* copy;
  char* save;
  char* token;
  char* events[128];
  int event_count = 0;
  int i;
  int update_index = 0;
  u32 last_tag = 0u;
  cmg_replay_alloc allocs[64];
  int alloc_count = 0;
  const char* previous_phase = g_trace_phase;
  if (native_trace == NULL || native_trace[0] == '\0' || !g_initialized || !g_player_active) {
    return 0u;
  }
  copy = strdup(native_trace);
  if (copy == NULL) {
    return 0u;
  }
  token = strtok_r(copy, ";", &save);
  while (token != NULL && event_count < (int) (sizeof(events) / sizeof(events[0]))) {
    events[event_count++] = token;
    token = strtok_r(NULL, ";", &save);
  }
  g_trace_phase = "replay";
  for (i = 0; i < event_count; i++) {
    const char* event = events[i];
    if (cmg_trace_starts_with(event, "_CMG_InitPlayer")) {
      continue;
    }
    if (cmg_trace_starts_with(event, "_CMG_UpdatePlayer")) {
      uint64_t delta = 0u;
      if (update_base_time_ms > 0u
          && cmg_parse_trace_update_delta(update_trace, update_index, &delta)) {
        int64_t clock = (int64_t) update_base_time_ms + (int64_t) delta + clock_offset_ms;
        g_forced_clock_ms = clock > 0 ? (uint64_t) clock : 0u;
      }
      last_tag = cmg_update_player_with_fresh_tag();
      g_update_tag = last_tag;
      update_index++;
      continue;
    }
    if (cmg_trace_starts_with(event, "_jsmalloc:")) {
      u32 size = cmg_parse_event_number(event, "_jsmalloc:");
      u32 official = cmg_parse_event_number(event, "->");
      if (i + 1 < event_count
          && (cmg_trace_starts_with(events[i + 1], "_CMG_UpdatePlayer")
              || cmg_trace_starts_with(events[i + 1], "_CMG_InitPlayer"))) {
        continue;
      }
      if (size > 0u && official > 0u && alloc_count < (int) (sizeof(allocs) / sizeof(allocs[0]))) {
        u32 actual = (*Z_CaZ_ii)(size);
        allocs[alloc_count].official = official;
        allocs[alloc_count].actual = actual;
        alloc_count++;
        if (g_update_call_log_count < 24) {
          LOGI("CMG replay malloc size=%u official=%u actual=%u", size, official, actual);
        }
      }
      continue;
    }
    if (cmg_trace_starts_with(event, "_jsfree:")) {
      u32 official = cmg_parse_event_number(event, "_jsfree:");
      u32 actual = cmg_replay_lookup_alloc(allocs, alloc_count, official);
      if (actual != 0u) {
        (*Z_BaZ_vi)(actual);
        cmg_replay_remove_alloc(allocs, &alloc_count, official);
        if (g_update_call_log_count < 24) {
          LOGI("CMG replay free official=%u actual=%u", official, actual);
        }
      }
      continue;
    }
  }
  g_trace_phase = previous_phase;
  free(copy);
  return last_tag;
}


int cmg_native_init(const char* location_href, const char* player_tag) {
    int res = 0;
    cmg_mutex_lock();
    if (location_href != NULL) {
        snprintf(g_forced_location_href, sizeof(g_forced_location_href), "%s", location_href);
    }
    if (player_tag != NULL) {
        snprintf(g_forced_player_tag, sizeof(g_forced_player_tag), "%s", player_tag);
    }
    res = cmg_init_locked();
    cmg_mutex_unlock();
    return res;
}

int cmg_native_update(void) {
    u32 tag = 0;
    cmg_mutex_lock();
    if (cmg_init_locked() && g_player_active) {
        tag = cmg_update_player_with_fresh_tag();
        g_update_tag = tag;
    }
    cmg_mutex_unlock();
    return (int)tag;
}

int cmg_native_decode_nal_in_place(uint8_t* buffer, int offset, int length, int live, int run_steps) {
    int result = -1;
    u32 data_address, tag_address, host_length, update_tag, output_length;
    size_t data_allocation_size, tag_length;
    int trap, index;
    uint8_t *data_pointer, *tag_pointer;
    cmg_decode_function live_functions[9];
    cmg_decode_function vod_functions[9];
    cmg_decode_function* functions;

    if (buffer == NULL || offset < 0 || length <= 0) return -1;

    cmg_mutex_lock();
    if (!cmg_init_locked() || !g_player_active) {
        cmg_mutex_unlock();
        return -1;
    }

    live_functions[0] = Z_eaZ_iiiii;
    live_functions[1] = Z_faZ_iiiii;
    live_functions[2] = Z_gaZ_iiiii;
    live_functions[3] = Z_haZ_iiiii;
    live_functions[4] = Z_iaZ_iiiii;
    live_functions[5] = Z_jaZ_iiiii;
    live_functions[6] = Z_kaZ_iiiii;
    live_functions[7] = Z_laZ_iiiii;
    live_functions[8] = Z_maZ_iiiii;
    vod_functions[0] = Z_naZ_iiiii;
    vod_functions[1] = Z_oaZ_iiiii;
    vod_functions[2] = Z_paZ_iiiii;
    vod_functions[3] = Z_qaZ_iiiii;
    vod_functions[4] = Z_raZ_iiiii;
    vod_functions[5] = Z_saZ_iiiii;
    vod_functions[6] = Z_taZ_iiiii;
    vod_functions[7] = Z_uaZ_iiiii;
    vod_functions[8] = Z_vaZ_iiiii;
    functions = live ? live_functions : vod_functions;

    host_length = live ? (u32) strlen(CMG_PAGE_HOST) : 0;
    data_allocation_size = (size_t) length + CMG_NAL_MEMORY_EXTEND;
    if (g_decode_data_address == 0 || g_decode_data_capacity < (u32) data_allocation_size) {
        if (g_decode_data_address != 0) (*Z_BaZ_vi)(g_decode_data_address);
        g_decode_data_address = (*Z_CaZ_ii)((u32) data_allocation_size);
        g_decode_data_capacity = (u32) data_allocation_size;
    }
    tag_length = strlen(g_player_tag);
    if (g_decode_tag_address == 0 || g_decode_tag_capacity < (u32) tag_length) {
        if (g_decode_tag_address != 0) (*Z_BaZ_vi)(g_decode_tag_address);
        g_decode_tag_address = (*Z_CaZ_ii)((u32) tag_length);
        g_decode_tag_capacity = (u32) tag_length;
    }
    data_address = g_decode_data_address;
    tag_address = g_decode_tag_address;
    data_pointer = cmg_pointer(data_address, data_allocation_size);
    tag_pointer = cmg_pointer(tag_address, tag_length);
    if (data_pointer == NULL || tag_pointer == NULL) {
        cmg_mutex_unlock();
        return -1;
    }
    memcpy(data_pointer, buffer + offset, (size_t) length);
    if (live && host_length > 0) {
        memcpy(data_pointer + length, CMG_PAGE_HOST, host_length);
    }
    memcpy(tag_pointer, g_player_tag, tag_length);

    trap = wasm_rt_impl_try();
    if (trap == 0) {
        update_tag = g_update_tag;
        if (update_tag == 0) {
            update_tag = cmg_update_player_with_fresh_tag();
            g_update_tag = update_tag;
        }
        if (run_steps) {
            for (index = 0; index < 8; index++) {
                if (cmg_should_run_decode_step(update_tag, index)) {
                    functions[7 - index](tag_address, data_address, (u32) length, host_length);
                }
            }
        }
        if (live) {
            output_length = functions[8](tag_address, data_address, (u32) length, host_length);
        } else {
            output_length = functions[8](data_address, tag_address, (u32) length, host_length);
        }
        if (output_length <= (u32) length) {
            memcpy(buffer + offset, data_pointer, (size_t) output_length);
            result = (int) output_length;
        } else {
            result = -2;
        }
    } else {
        result = -1;
    }
    cmg_mutex_unlock();
    return result;
}

typedef struct {
    uint8_t* data;
    size_t size;
    size_t capacity;
} CmgBuffer;

static void cmg_buf_init(CmgBuffer* b) {
    b->data = NULL;
    b->size = 0;
    b->capacity = 0;
}

static void cmg_buf_append(CmgBuffer* b, const uint8_t* src, size_t len) {
    if (b->size + len > b->capacity) {
        size_t new_cap = (b->capacity == 0) ? 4096 : b->capacity * 2;
        while (b->size + len > new_cap) new_cap *= 2;
        b->data = (uint8_t*)realloc(b->data, new_cap);
        b->capacity = new_cap;
    }
    memcpy(b->data + b->size, src, len);
    b->size += len;
}

static void cmg_buf_free(CmgBuffer* b) {
    free(b->data);
    cmg_buf_init(b);
}

typedef struct {
    size_t pkt_index;
    size_t payload_offset;
    size_t payload_len;
} CmgPacketRef;

typedef struct {
    CmgPacketRef* refs;
    size_t ref_count;
    size_t ref_cap;
    CmgBuffer payload;
    size_t header_len;
} CmgPesFrame;

static void cmg_pes_init(CmgPesFrame* pf) {
    pf->refs = NULL;
    pf->ref_count = 0;
    pf->ref_cap = 0;
    cmg_buf_init(&pf->payload);
    pf->header_len = 0;
}

static void cmg_pes_add_ref(CmgPesFrame* pf, size_t pkt_idx, size_t offset, size_t len) {
    if (pf->ref_count >= pf->ref_cap) {
        pf->ref_cap = (pf->ref_cap == 0) ? 16 : pf->ref_cap * 2;
        pf->refs = (CmgPacketRef*)realloc(pf->refs, pf->ref_cap * sizeof(CmgPacketRef));
    }
    pf->refs[pf->ref_count].pkt_index = pkt_idx;
    pf->refs[pf->ref_count].payload_offset = offset;
    pf->refs[pf->ref_count].payload_len = len;
    pf->ref_count++;
}

static void cmg_pes_free(CmgPesFrame* pf) {
    free(pf->refs);
    cmg_buf_free(&pf->payload);
}

static int cmg_find_video_pid(const uint8_t* ts, size_t total_len) {
    size_t pkt_count = total_len / 188;
    int pmt_pid = -1;
    for (size_t p = 0; p < pkt_count; p++) {
        size_t i = p * 188;
        if (ts[i] != 0x47) break;
        int pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
        int pusi = (ts[i + 1] & 0x40) >> 6;
        int afc = (ts[i + 3] & 0x30) >> 4;
        if (afc == 2) continue;
        size_t o = i + 4;
        if (afc == 3) o += 1 + ts[o];
        if (o >= i + 188) continue;

        if (pid == 0 && pmt_pid < 0) {
            if (pusi) o += 1 + ts[o];
            if (o + 3 >= i + 188) continue;
            int sec_len = ((ts[o + 1] & 0x0f) << 8) | ts[o + 2];
            size_t end = o + 3 + sec_len - 4;
            size_t e = o + 8;
            while (e + 4 <= end && e + 4 <= i + 188) {
                int prog = (ts[e] << 8) | ts[e + 1];
                int map_pid = ((ts[e + 2] & 0x1f) << 8) | ts[e + 3];
                if (prog != 0) {
                    pmt_pid = map_pid;
                    break;
                }
                e += 4;
            }
        } else if (pid == pmt_pid && pmt_pid >= 0) {
            if (pusi) o += 1 + ts[o];
            if (o + 12 >= i + 188) continue;
            int sec_len = ((ts[o + 1] & 0x0f) << 8) | ts[o + 2];
            size_t end = o + 3 + sec_len - 4;
            int prog_info_len = ((ts[o + 10] & 0x0f) << 8) | ts[o + 11];
            size_t e = o + 12 + prog_info_len;
            while (e + 5 <= end && e + 5 <= i + 188) {
                uint8_t stream_type = ts[e];
                int es_pid = ((ts[e + 1] & 0x1f) << 8) | ts[e + 2];
                int es_info_len = ((ts[e + 3] & 0x0f) << 8) | ts[e + 4];
                if (stream_type == 0x1b || stream_type == 0x24 || stream_type == 0x1c) {
                    return es_pid;
                }
                e += 5 + es_info_len;
            }
        }
    }
    return -1;
}

int cmg_native_decrypt_ts(uint8_t* ts_data, size_t ts_size, int per_nal_update, int sanitize_sps) {
    if (ts_data == NULL || ts_size < 188) return -1;

    // Ensure WASM is initialized
    if (!g_initialized) {
        if (!cmg_native_init("https://www.yangshipin.cn/tv/home", "1791208727000")) {
            return -1;
        }
    }

    int video_pid = cmg_find_video_pid(ts_data, ts_size);
    if (video_pid < 0) return 0;

    size_t pkt_count = ts_size / 188;
    CmgPesFrame* frames = NULL;
    size_t frame_count = 0;
    size_t frame_cap = 0;
    CmgPesFrame cur_frame;
    cmg_pes_init(&cur_frame);

    for (size_t p = 0; p < pkt_count; p++) {
        size_t i = p * 188;
        if (ts_data[i] != 0x47) break;
        int pid = ((ts_data[i + 1] & 0x1f) << 8) | ts_data[i + 2];
        if (pid != video_pid) continue;
        int pusi = (ts_data[i + 1] & 0x40) != 0;
        int afc = (ts_data[i + 3] & 0x30) >> 4;
        if (afc != 1 && afc != 3) continue;
        int adapt_len = (afc == 3) ? ts_data[i + 4] : 0;
        size_t pstart = i + 4 + ((afc == 3) ? (1 + adapt_len) : 0);
        if (pstart >= i + 188) continue;
        size_t plen = (i + 188) - pstart;

        if (pusi) {
            if (cur_frame.payload.size > 0) {
                if (frame_count >= frame_cap) {
                    frame_cap = (frame_cap == 0) ? 64 : frame_cap * 2;
                    frames = (CmgPesFrame*)realloc(frames, frame_cap * sizeof(CmgPesFrame));
                }
                frames[frame_count++] = cur_frame;
                cmg_pes_init(&cur_frame);
            }
            if (plen >= 9) {
                cur_frame.header_len = 9 + ts_data[pstart + 8];
            }
        }
        cmg_pes_add_ref(&cur_frame, p, pstart, plen);
        cmg_buf_append(&cur_frame.payload, ts_data + pstart, plen);
    }
    if (cur_frame.payload.size > 0) {
        if (frame_count >= frame_cap) {
            frame_cap = (frame_cap == 0) ? 64 : frame_cap * 2;
            frames = (CmgPesFrame*)realloc(frames, frame_cap * sizeof(CmgPesFrame));
        }
        frames[frame_count++] = cur_frame;
    }

    int decrypted_slices = 0;
    int is_scrambled = -1; // -1: unknown, 0: plaintext, 1: scrambled

    for (size_t f = 0; f < frame_count; f++) {
        CmgPesFrame* pf = &frames[f];
        uint8_t* pdata = pf->payload.data;
        size_t plen = pf->payload.size;
        if (plen < pf->header_len || plen < 4) continue;
        if (pdata[0] != 0 || pdata[1] != 0 || pdata[2] != 1) continue;

        size_t pos = pf->header_len;
        size_t nal_offsets[128];
        size_t nal_sc_lens[128];
        size_t nal_count = 0;

        while (pos + 3 < plen && nal_count < 128) {
            if (pdata[pos] == 0 && pdata[pos + 1] == 0) {
                size_t sc_len = 0;
                if (pdata[pos + 2] == 1) {
                    sc_len = 3;
                } else if (pdata[pos + 2] == 0 && pos + 3 < plen && pdata[pos + 3] == 1) {
                    sc_len = 4;
                }
                if (sc_len > 0) {
                    nal_offsets[nal_count] = pos + sc_len;
                    nal_sc_lens[nal_count] = sc_len;
                    nal_count++;
                    pos += sc_len;
                    continue;
                }
            }
            pos++;
        }

        for (size_t n = 0; n < nal_count; n++) {
            size_t nstart = nal_offsets[n];
            size_t nend = (n + 1 < nal_count) ? (nal_offsets[n + 1] - nal_sc_lens[n + 1]) : plen;
            size_t nlen = nend - nstart;
            if (nlen == 0) continue;

            uint8_t nal_type = pdata[nstart] & 0x1f;

            if (nal_type == 7) { // SPS
                if (is_scrambled == -1 && nlen > 2) {
                    // Check if scrambling flags in byte 2 are present
                    is_scrambled = ((pdata[nstart + 2] & 3) != 0) ? 1 : 0;
                }
                if (is_scrambled != 0) {
                    if (per_nal_update) cmg_native_update();
                    cmg_native_decode_nal_in_place(pdata, (int)nstart, (int)nlen, 1, 1);
                    if (sanitize_sps && nlen > 2) {
                        pdata[nstart + 2] &= 0xfc;
                    }
                }
            } else if (nal_type == 1 || nal_type == 5) { // Slice / IDR
                if (is_scrambled != 0) {
                    decrypted_slices++;
                    if (per_nal_update) cmg_native_update();
                    cmg_native_decode_nal_in_place(pdata, (int)nstart, (int)nlen, 1, 1);
                }
            }
        }

        // Copy modified PES back to TS packets only if scrambled
        if (is_scrambled != 0) {
            size_t cur_off = 0;
            for (size_t r = 0; r < pf->ref_count; r++) {
                CmgPacketRef* pref = &pf->refs[r];
                memcpy(ts_data + pref->payload_offset, pdata + cur_off, pref->payload_len);
                cur_off += pref->payload_len;
            }
        }
    }

    for (size_t f = 0; f < frame_count; f++) cmg_pes_free(&frames[f]);
    free(frames);

    return decrypted_slices;
}

