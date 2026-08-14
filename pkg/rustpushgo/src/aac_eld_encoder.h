#ifndef IBLUE_AAC_ELD_ENCODER_H
#define IBLUE_AAC_ELD_ENCODER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Create a stateful AudioToolbox AAC-ELD encoder matching FaceTime PT104:
// 24 kHz mono float PCM in, 480-sample access units out, 48 kb/s.
void *iblue_aac_eld_encoder_create(char *error, size_t error_capacity);

// Encode exactly 480 mono float samples (20 ms at 24 kHz). A successful call
// may emit zero bytes while AudioToolbox buffers its startup lookahead.
int iblue_aac_eld_encoder_encode(
    void *context,
    const float *samples,
    uint32_t sample_count,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *output_size,
    char *error,
    size_t error_capacity);

// Drain at most one remaining access unit. Set `finished` when no more output
// remains; output_size can be zero on the finishing call.
int iblue_aac_eld_encoder_finish(
    void *context,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *output_size,
    int *finished,
    char *error,
    size_t error_capacity);

void iblue_aac_eld_encoder_destroy(void *context);

#ifdef __cplusplus
}
#endif

#endif
