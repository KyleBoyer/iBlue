#import "evs_encoder.h"

#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>

typedef struct {
    AudioStreamBasicDescription asbd;
    uint32_t samples_per_frame;
} IBlueVCAudioFrameFormat;

// VCAudioPayload asks AVConference for the public AudioBufferList at offset
// 0xa8. The remaining private bookkeeping is not observed by the encoder.
typedef struct {
    uint8_t private_prefix[0xa8];
    AudioBufferList audio_buffer_list;
} IBlueMinimalVCAudioBufferList;

static void set_error(char *buffer, size_t capacity, NSString *message) {
    if (buffer == NULL || capacity == 0) return;
    const char *utf8 = message.UTF8String ?: "Unknown EVS encoder error";
    snprintf(buffer, capacity, "%s", utf8);
}

void *iblue_evs_encoder_create(char *error, size_t error_capacity) {
    @autoreleasepool {
        @try {
            void *framework = dlopen(
                "/System/Library/PrivateFrameworks/AVConference.framework/AVConference",
                RTLD_NOW | RTLD_LOCAL);
            if (framework == NULL) {
                set_error(error, error_capacity, @"Apple AVConference.framework is unavailable");
                return NULL;
            }

            Class config_class = NSClassFromString(@"VCAudioPayloadConfig");
            Class payload_class = NSClassFromString(@"VCAudioPayload");
            if (config_class == Nil || payload_class == Nil) {
                set_error(error, error_capacity, @"Apple's FaceTime EVS encoder classes are unavailable");
                return NULL;
            }

            // These keys and values mirror Apple's installed
            // session_config_presence.plist: EVS codec type 4, PT108,
            // preferred mode 14 (13.2 kb/s), 32 kHz codec / 24 kHz input.
            NSDictionary *configuration = @{
                @"vcAudioPayloadConfigKeyPayloadType": @108,
                @"vcAudioPayloadConfigKeyCodecType": @4,
                @"vcPayloadConfigKeySampleRate": @32000,
                @"vcAudioPayloadConfigKeyInputSampleRate": @24000,
                // FaceTime's installed presence/U1 profile advertises EVS at
                // 16 packets/second with three 20 ms codec frames per RTP
                // payload. VCAudioPayload assembles the RFC 8724 multi-frame
                // payload for us on every third encode call.
                @"vcPayloadConfigKeyInternalBundleFactor": @3,
                @"vcPayloadConfigKeyMaxBundleFactor": @3,
                @"vcAudioPayloadConfigKeyBlockSize": @640,
                @"vcPayloadConfigKeyOctetAligned": @YES,
                @"vcPayloadConfigKeyDTXEnabled": @NO,
                @"vcPayloadConfigKeyEVSSIDPeriod": @0,
                @"vcPayloadConfigKeyEVSChannelAwareOffset": @0,
                @"vcPayloadConfigKeyEVSHeaderFullOnly": @YES,
                @"vcPayloadConfigKeyEVSCMRMode": @14,
                @"vcPayloadConfigKeyPreferredBitrate": @13200,
                @"vcPayloadConfigKeyCodecBitrates": @[
                    @5900, @7200, @8000, @9600, @13200, @16400, @24400
                ],
            };

            id config = ((id (*)(id, SEL))objc_msgSend)(
                (id)config_class, sel_registerName("alloc"));
            config = ((id (*)(id, SEL, id))objc_msgSend)(
                config, sel_registerName("initWithConfigDict:"), configuration);
            if (config == nil) {
                set_error(error, error_capacity, @"Apple rejected the FaceTime EVS payload configuration");
                return NULL;
            }

            id payload = ((id (*)(id, SEL))objc_msgSend)(
                (id)payload_class, sel_registerName("alloc"));
            payload = ((id (*)(id, SEL, id))objc_msgSend)(
                payload, sel_registerName("initWithConfig:"), config);
            if (payload == nil) {
                set_error(error, error_capacity, @"Apple could not create the FaceTime EVS payload");
                return NULL;
            }

            IBlueVCAudioFrameFormat format = {0};
            format.asbd.mSampleRate = 24000;
            format.asbd.mFormatID = kAudioFormatLinearPCM;
            format.asbd.mFormatFlags = kAudioFormatFlagsNativeFloatPacked;
            format.asbd.mBytesPerPacket = sizeof(float);
            format.asbd.mFramesPerPacket = 1;
            format.asbd.mBytesPerFrame = sizeof(float);
            format.asbd.mChannelsPerFrame = 1;
            format.asbd.mBitsPerChannel = 32;
            format.samples_per_frame = 480;
            BOOL created = ((BOOL (*)(id, SEL, const IBlueVCAudioFrameFormat *))objc_msgSend)(
                payload, sel_registerName("createEncoderWithInputFormat:"), &format);
            if (!created) {
                set_error(error, error_capacity, @"Apple could not initialize the FaceTime EVS encoder");
                return NULL;
            }
            return (__bridge_retained void *)payload;
        } @catch (NSException *exception) {
            set_error(error, error_capacity, exception.reason ?: exception.name);
            return NULL;
        }
    }
}

int iblue_evs_encoder_encode(
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
            set_error(error, error_capacity, @"FaceTime EVS encode received a null argument");
            return -1;
        }
        if (sample_count != 480) {
            set_error(error, error_capacity, @"FaceTime EVS requires exactly 480 samples per frame");
            return -2;
        }
        @try {
            IBlueMinimalVCAudioBufferList input = {0};
            input.audio_buffer_list.mNumberBuffers = 1;
            input.audio_buffer_list.mBuffers[0].mNumberChannels = 1;
            input.audio_buffer_list.mBuffers[0].mDataByteSize = sample_count * sizeof(float);
            input.audio_buffer_list.mBuffers[0].mData = (void *)samples;

            uint32_t short_red_bytes = 0;
            id payload = (__bridge id)context;
            int encoded = ((int (*)(id, SEL, void *, int, void *, int, uint32_t *))objc_msgSend)(
                payload,
                sel_registerName("encodeAudio:numInputSamples:outputBytes:numOutputBytes:shortREDBytes:"),
                &input,
                (int)sample_count,
                output,
                (int)output_capacity,
                &short_red_bytes);
            // A bundle factor of three deliberately returns zero bytes for
            // the first two 20 ms inputs. That is a successful buffered
            // encode; the third call emits the complete 60 ms payload.
            if (encoded < 0 || (uint32_t)encoded > output_capacity || short_red_bytes != 0) {
                set_error(error, error_capacity, @"Apple's FaceTime EVS encoder returned an invalid access unit");
                return encoded < 0 ? encoded : -3;
            }
            *output_size = (uint32_t)encoded;
            return 0;
        } @catch (NSException *exception) {
            set_error(error, error_capacity, exception.reason ?: exception.name);
            return -4;
        }
    }
}

void iblue_evs_encoder_destroy(void *context) {
    if (context == NULL) return;
    @autoreleasepool {
        (void)CFBridgingRelease(context);
    }
}
