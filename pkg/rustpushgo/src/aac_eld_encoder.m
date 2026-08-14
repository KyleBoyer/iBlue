#import "aac_eld_encoder.h"

#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>

typedef struct {
    AudioConverterRef converter;
    AudioStreamBasicDescription input_format;
    AudioStreamBasicDescription output_format;
} IBlueAacEldEncoder;

typedef struct {
    const float *samples;
    UInt32 frames;
    BOOL supplied;
} IBlueAacEldInput;

static void set_error(char *buffer, size_t capacity, NSString *message) {
    if (buffer == NULL || capacity == 0) return;
    const char *utf8 = message.UTF8String ?: "Unknown AAC-ELD encoder error";
    snprintf(buffer, capacity, "%s", utf8);
}

static NSString *status_text(OSStatus status) {
    UInt32 value = CFSwapInt32HostToBig((UInt32)status);
    char fourcc[5] = {0};
    memcpy(fourcc, &value, 4);
    BOOL printable = YES;
    for (NSUInteger index = 0; index < 4; index++) {
        if (fourcc[index] < 0x20 || fourcc[index] > 0x7e) printable = NO;
    }
    return printable
        ? [NSString stringWithFormat:@"'%s' (%d)", fourcc, (int)status]
        : [NSString stringWithFormat:@"%d", (int)status];
}

static OSStatus provide_input(
    AudioConverterRef converter,
    UInt32 *packet_count,
    AudioBufferList *data,
    AudioStreamPacketDescription **packet_description,
    void *user_data) {
    (void)converter;
    if (packet_description != NULL) *packet_description = NULL;
    IBlueAacEldInput *input = user_data;
    if (input == NULL || input->supplied || input->samples == NULL || input->frames == 0) {
        *packet_count = 0;
        return noErr;
    }
    UInt32 frames = MIN(*packet_count, input->frames);
    data->mNumberBuffers = 1;
    data->mBuffers[0].mNumberChannels = 1;
    data->mBuffers[0].mDataByteSize = frames * sizeof(float);
    data->mBuffers[0].mData = (void *)input->samples;
    *packet_count = frames;
    input->supplied = YES;
    return noErr;
}

static int fill_one_packet(
    IBlueAacEldEncoder *encoder,
    IBlueAacEldInput *input,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *output_size,
    char *error,
    size_t error_capacity) {
    AudioBufferList output_buffers = {0};
    output_buffers.mNumberBuffers = 1;
    output_buffers.mBuffers[0].mNumberChannels = 1;
    output_buffers.mBuffers[0].mDataByteSize = output_capacity;
    output_buffers.mBuffers[0].mData = output;
    AudioStreamPacketDescription packet = {0};
    UInt32 packet_count = 1;
    OSStatus status = AudioConverterFillComplexBuffer(
        encoder->converter,
        provide_input,
        input,
        &packet_count,
        &output_buffers,
        &packet);
    if (status != noErr) {
        set_error(
            error,
            error_capacity,
            [NSString stringWithFormat:@"AudioConverterFillComplexBuffer failed: %@", status_text(status)]);
        return -1;
    }
    if (packet_count > 1 || output_buffers.mBuffers[0].mDataByteSize > output_capacity) {
        set_error(error, error_capacity, @"AudioToolbox returned an invalid AAC-ELD access unit");
        return -2;
    }
    *output_size = packet_count == 0 ? 0 : output_buffers.mBuffers[0].mDataByteSize;
    return 0;
}

void *iblue_aac_eld_encoder_create(char *error, size_t error_capacity) {
    @autoreleasepool {
        IBlueAacEldEncoder *encoder = calloc(1, sizeof(IBlueAacEldEncoder));
        if (encoder == NULL) {
            set_error(error, error_capacity, @"Could not allocate the AAC-ELD encoder");
            return NULL;
        }
        encoder->input_format = (AudioStreamBasicDescription) {
            .mSampleRate = 24000,
            .mFormatID = kAudioFormatLinearPCM,
            .mFormatFlags = kAudioFormatFlagsNativeFloatPacked,
            .mBytesPerPacket = sizeof(float),
            .mFramesPerPacket = 1,
            .mBytesPerFrame = sizeof(float),
            .mChannelsPerFrame = 1,
            .mBitsPerChannel = 32,
        };
        encoder->output_format = (AudioStreamBasicDescription) {
            .mSampleRate = 24000,
            .mFormatID = kAudioFormatMPEG4AAC_ELD,
            .mFramesPerPacket = 480,
            .mChannelsPerFrame = 1,
        };
        UInt32 format_size = sizeof(encoder->output_format);
        OSStatus status = AudioFormatGetProperty(
            kAudioFormatProperty_FormatInfo,
            0,
            NULL,
            &format_size,
            &encoder->output_format);
        if (status == noErr) {
            status = AudioConverterNew(
                &encoder->input_format,
                &encoder->output_format,
                &encoder->converter);
        }
        if (status == noErr) {
            UInt32 bitrate = 48000;
            status = AudioConverterSetProperty(
                encoder->converter,
                kAudioConverterEncodeBitRate,
                sizeof(bitrate),
                &bitrate);
        }
        if (status == noErr) {
            UInt32 quality = kAudioConverterQuality_Max;
            status = AudioConverterSetProperty(
                encoder->converter,
                kAudioConverterCodecQuality,
                sizeof(quality),
                &quality);
        }
        if (status == noErr) {
            UInt32 prime_method = kConverterPrimeMethod_None;
            (void)AudioConverterSetProperty(
                encoder->converter,
                kAudioConverterPrimeMethod,
                sizeof(prime_method),
                &prime_method);
        }
        if (status != noErr) {
            if (encoder->converter != NULL) AudioConverterDispose(encoder->converter);
            free(encoder);
            set_error(
                error,
                error_capacity,
                [NSString stringWithFormat:@"Could not initialize AAC-ELD AudioConverter: %@", status_text(status)]);
            return NULL;
        }
        return encoder;
    }
}

int iblue_aac_eld_encoder_encode(
    void *context,
    const float *samples,
    uint32_t sample_count,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *output_size,
    char *error,
    size_t error_capacity) {
    @autoreleasepool {
        if (output_size != NULL) *output_size = 0;
        if (context == NULL || samples == NULL || output == NULL || output_size == NULL) {
            set_error(error, error_capacity, @"AAC-ELD encode received a null argument");
            return -1;
        }
        if (sample_count != 480) {
            set_error(error, error_capacity, @"FaceTime AAC-ELD requires exactly 480 samples per frame");
            return -2;
        }
        IBlueAacEldInput input = { .samples = samples, .frames = sample_count, .supplied = NO };
        return fill_one_packet(context, &input, output, output_capacity, output_size, error, error_capacity);
    }
}

int iblue_aac_eld_encoder_finish(
    void *context,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *output_size,
    int *finished,
    char *error,
    size_t error_capacity) {
    @autoreleasepool {
        if (output_size != NULL) *output_size = 0;
        if (finished != NULL) *finished = 0;
        if (context == NULL || output == NULL || output_size == NULL || finished == NULL) {
            set_error(error, error_capacity, @"AAC-ELD finish received a null argument");
            return -1;
        }
        IBlueAacEldInput input = {0};
        int result = fill_one_packet(
            context, &input, output, output_capacity, output_size, error, error_capacity);
        if (result == 0 && *output_size == 0) *finished = 1;
        return result;
    }
}

void iblue_aac_eld_encoder_destroy(void *context) {
    if (context == NULL) return;
    IBlueAacEldEncoder *encoder = context;
    if (encoder->converter != NULL) AudioConverterDispose(encoder->converter);
    free(encoder);
}
