#ifndef CMG_NATIVE_H
#define CMG_NATIVE_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int cmg_native_init(const char* location_href, const char* player_tag);
int cmg_native_update(void);
int cmg_native_decode_nal_in_place(uint8_t* buffer, int offset, int length, int live, int run_steps);
int cmg_native_decrypt_ts(uint8_t* ts_data, size_t ts_size, int per_nal_update, int sanitize_sps);

#ifdef __cplusplus
}
#endif

#endif // CMG_NATIVE_H
