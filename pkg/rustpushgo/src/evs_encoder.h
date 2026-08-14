#ifndef IBLUE_EVS_ENCODER_H
#define IBLUE_EVS_ENCODER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Apple keeps the FaceTime EVS AudioComponent private, but AVConference
// exposes the same encoder through VCAudioPayload. The returned context owns
// one stateful 13.2 kb/s EVS encoder configured for 20 ms mono frames.
void *iblue_evs_encoder_create(char *error, size_t error_capacity);

// Encode exactly 480 mono float samples at 24 kHz. Returns 0 on success.
int iblue_evs_encoder_encode(
    void *context,
    const float *samples,
    uint32_t sample_count,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *output_size,
    char *error,
    size_t error_capacity);

void iblue_evs_encoder_destroy(void *context);

#ifdef __cplusplus
}
#endif

#endif
