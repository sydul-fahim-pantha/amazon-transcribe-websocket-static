const audioUtils        = require('./audioUtils');  // for encoding audio data as PCM
const crypto            = require('crypto'); // tot sign our pre-signed URL
const v4                = require('./aws-signature-v4'); // to generate our pre-signed URL
const marshaller        = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node    = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic               = require('microphone-stream'); // collect microphone input as a stream of raw bytes

// our converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);

// our global variables for managing state
let languageCode;
let region;
let sampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;

// check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
    // Use our helper method to show an error on the page
    showError('We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again.');

    // maintain enabled/distabled state for the start and stop buttons
    toggleStartStop();
}

$('#start-button').click(function () {
    $('#error').hide(); // hide any existing errors
    toggleStartStop(true); // disable start and enable stop button

    // set the language and region from the dropdowns
    setLanguage();
    setRegion();

    // first we get the microphone input from the browser (as a promise)...
    window.navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true
        })
        // ...then we convert the mic stream to binary event stream messages when the promise resolves 
        .then(streamAudioToWebSocket) 
        .catch(function (error) {
            showError('There was an error streaming your audio to Amazon Transcribe. Please try again.');
            toggleStartStop();
        });
});

let byteOffset = 0;
let length = 1023; 
let onlyonce = true;
let iteration = 0;
let byteOffset_i = 0
let audioArrayBuffer = null;
let audiofileArrayBufferLen = 0;

let streamAudioToWebSocket = function (userMediaStream) {
    //let's get the mic input from the browser, via the microphone-stream module
    micStream = new mic();
    micStream.setStream(userMediaStream);

    // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    let url = createRegularTranscribePresignedUrl(); //createPresignedUrl();

    //open up our WebSocket connection
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    // when we get audio data from the mic, send it to the WebSocket if possible
    socket.onopen = function () {
        micStream.on('data', function (rawAudioChunk) {
            // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
            let binary = convertAudioToBinaryMessage(rawAudioChunk);
             
            if (onlyonce) { 
                onlyonce = false; 
                let audiofile = document.getElementById("myfileinput").files[0]; 
                audiofile.arrayBuffer().then( arrayBuffer => { 

                    audioArrayBuffer = arrayBuffer;
                    console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>.. processing audio"); 
                    console.log(arrayBuffer); 

                    audiofileArrayBufferLen = audioArrayBuffer.byteLength;
                    console.log("audiofileArrayBufferLen:" + audiofileArrayBufferLen);
                    console.log("audiofileArrayBufferLen/1024:" + audiofileArrayBufferLen / 1024);
                    iteration = Math.ceil(audiofileArrayBufferLen / 1024);
                }, error => { alert(error);});
            }
            console.log("audiofileArrayBufferLen: " + audiofileArrayBufferLen);
            if (audioArrayBuffer) {
                byteOffset = 1024 * byteOffset_i;
                console.log("byteOffset: " + byteOffset);
                console.log("audiofileArrayBufferLen: " + audiofileArrayBufferLen);
                console.log("length: " + length);
                console.log("i: " + byteOffset_i + " iteration: " + iteration);
                if (byteOffset_i == iteration - 1) {
                    length = audiofileArrayBufferLen - byteOffset;
                } 
                
                let audioEventMessage = getAudioEventMessage(Buffer.from(audioArrayBuffer, byteOffset, length));
                
                console.log("audioEventMessage: >>>>>>>>>>>>>>>>");
                console.log(audioEventMessage);
        
                //convert the JSON object + headers into a binary event stream message
                let binary = eventStreamMarshaller.marshall(audioEventMessage);    

                if (byteOffset_i < iteration) {
                    if (socket.OPEN) {
                        socket.send(binary); 
                        console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>.. file sent"); 
                    }
                }    
                byteOffset_i++;
            }
            
        }
        )
    };

    // handle messages, errors, and close events
    wireSocketEvents();
}

function setLanguage() {
    languageCode = $('#language').find(':selected').val();
    if (languageCode == "en-US" || languageCode == "es-US")
        sampleRate = 44100;
    else
        sampleRate = 8000;
}

function setRegion() {
    region = $('#region').find(':selected').val();
}

function wireSocketEvents() {
    // handle inbound messages from Amazon Transcribe
    socket.onmessage = function (message) {
        //convert the binary event stream message to JSON
        let messageWrapper = eventStreamMarshaller.unmarshall(Buffer(message.data));
        let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
        if (messageWrapper.headers[":message-type"].value === "event") {
            handleEventStreamMessage(messageBody);
        }
        else {
            transcribeException = true;
            if (messageBody.Message != 'Your request timed out because no new audio was received for 15 seconds.') showError(messageBody.Message);
            toggleStartStop();
        }
        // console.log(">>>>>>>>>??????>>>>>>>>>>>>>.");
        // console.log(messageBody.Message);
        // console.log(byteOffset_i);
        // console.log(iteration);

        // If this is the last message 
        // close socket and download file
        if (byteOffset_i == iteration && iteration > 0) { 
            byteOffset = 0;
            onlyonce = true;
            iteration = 0;
            byteOffset_i = 0
            audioArrayBuffer = null;
            audiofileArrayBufferLen = 0;

            let str = $('#transcript')[0].value;
            let uri = 'data:text/txt;charset=utf-8,' + str;
            let downloadLink = document.createElement("a");
            downloadLink.href = uri;
            downloadLink.download = $('#myfileinput')[0].files[0].name;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            
            $('#stop-button').trigger( "click" );
        }    
    };

    socket.onerror = function () {
        socketError = true;
        showError('WebSocket connection error. Try again.');
        toggleStartStop();
    };

    socket.onclose = function (closeEvent) {
        micStream.stop();

        // the close event immediately follows the error event; only handle one.
        if (!socketError && !transcribeException) {
            if (closeEvent.code != 1000) {
                showError('</i><strong>Streaming Exception</strong><br>' + closeEvent.reason);
            }
            toggleStartStop();
        }
    };
}

let handleEventStreamMessage = function (messageJson) {
    let results = messageJson.Transcript.Results;

    if (results.length > 0) {
        if (results[0].Alternatives.length > 0) {
            let transcript = results[0].Alternatives[0].Transcript;

            // fix encoding for accented characters
            transcript = decodeURIComponent(escape(transcript));

            // update the textarea with the latest result
            $('#transcript').val(transcription + transcript + "\n");

            // if this transcript segment is final, add it to the overall transcription
            if (!results[0].IsPartial) {
                //scroll the textarea down
                $('#transcript').scrollTop($('#transcript')[0].scrollHeight);

                transcription += transcript + "\n";
            }
        }
    }
}

let closeSocket = function () {
    if (socket.OPEN) {
        micStream.stop();

        // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
        let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
        let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
        socket.send(emptyBuffer);
    }
}

$('#stop-button').click(function () {
    closeSocket();
    toggleStartStop();
});

$('#reset-button').click(function () {
    $('#transcript').val('');
    transcription = '';
});

function toggleStartStop(disableStart = false) {
    $('#start-button').prop('disabled', disableStart);
    $('#stop-button').attr("disabled", !disableStart);
}

function showError(message) {
    $('#error').html('<i class="fa fa-times-circle"></i> ' + message);
    $('#error').show();
}

function v2_convertAudioToBinaryMessage(audioChunk) {
    //let raw = mic.toRaw(audioChunk);

    // if (raw == null) return;

    // downsample and convert the raw audio bytes to PCM
    // let downsampledBuffer = audioUtils.downsampleBuffer(raw, sampleRate);
    // let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

    // add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(Buffer.from(audioChunk, 1024 * byteOffset, length1024));
    console.log("audioEventMessage: >>>>>>>>>>>>>>>>");
    console.log(audioEventMessage);

    //convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);

    return binary;
}

function convertAudioToBinaryMessage(audioChunk) {
    let raw = mic.toRaw(audioChunk);

    if (raw == null)
        return;

    // downsample and convert the raw audio bytes to PCM
    let downsampledBuffer = audioUtils.downsampleBuffer(raw, sampleRate);
    let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

    // add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

    //convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);

    return binary;
}

function getAudioEventMessage(buffer) {
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ':message-type': {
                type: 'string',
                value: 'event'
            },
            ':event-type': {
                type: 'string',
                value: 'AudioEvent'
            }
        },
        body: buffer
    };
}

function createPresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        'GET',
        endpoint,
        '/medical-stream-transcription-websocket',
        'transcribe',
        crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
        'key': $('#access_id').val(),
        'secret': $('#secret_key').val(),
        'sessionToken': $('#session_token').val(),
        'protocol': 'wss',
        'expires': 300,
        'region': region,
        'query': "language-code=" + languageCode + "&media-encoding=pcm&sample-rate=" + sampleRate + "&specialty=PRIMARYCARE&type=CONVERSATION"
    }
    );
}


function createTranscribeMedicalPresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        'GET',
        endpoint,
        '/medical-stream-transcription-websocket',
        'transcribe',
        crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
        'key': $('#access_id').val(),
        'secret': $('#secret_key').val(),
        'sessionToken': $('#session_token').val(),
        'protocol': 'wss',
        'expires': 300,
        'region': region,
        'query': "language-code=" + languageCode + "&media-encoding=pcm&sample-rate=" + sampleRate + "&specialty=PRIMARYCARE&type=CONVERSATION"
    }
    );
}

function createRegularTranscribePresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        'GET',
        endpoint,
        '/stream-transcription-websocket',
        'transcribe',
        crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
            'key': $('#access_id').val(),
            'secret': $('#secret_key').val(),
            'sessionToken': $('#session_token').val(),
            'protocol': 'wss',
            'expires': 15,
            'region': region,
            'query': "language-code=" + languageCode + "&media-encoding=pcm&sample-rate=" + sampleRate
        }
    );
}
