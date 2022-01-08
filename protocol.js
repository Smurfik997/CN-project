// START PROTOCOL

const requestType = { 
    'SEND_FILE_METADATA': 1, 'GET_FILE_METADATA': 2,  'SEND_PARTITION': 3, 'GET_PARTITION': 4
};
const typeLength = 1; // immutable
const hashLength = 64;
const headerLength = typeLength + hashLength;
// const ttlLength = 1;  // immutable
const fileNameLength = 256;
const fileSizeLength = 4;
const fileTypeLength = 32;
const ipLength = 4;
const portLength = 2;
const hostLength = ipLength + portLength;
const partitionNumberLength = 3;
const fileBufferLength = 1000;

const validate = (params) => {
    if (params.fileName && params.fileName > fileNameLength / 2) return false;
    if (params.fileSize && params.fileSize > 2 ** (8 * fileSizeLength) - 1) return false;
    if (params.fileType && params.fileType > fileTypeLength) return false;
    if (params.host && !/^\d{1,3}.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(params.host)) return false;
    if (params.partitionNumber && params.partitionNumber > 2 ** (8 * partitionNumberLength) - 1) return false;
    // if (params.ttl && params.ttl > 2 ** (8 * ttlLength) - 1) return false;

    return true;
};

const convertNumberToBuffer = (number, bufferSize) => {
    let buffer = new Uint8Array(bufferSize);

    for (let i = 0; i < bufferSize; i++) {
        buffer[i] = (number >> (8 * (bufferSize - i - 1))) & (2 ** 8 - 1);
    }

    return buffer;
}

const convertBufferToNumber = (buffer) => {
    let number = 0;
    
    for (let i = 0; i < buffer.byteLength; i++) {
        number += buffer[i] << (8 * (buffer.byteLength - i - 1));
    }

    return number;
}

const pack = async (type, hash, optional) => {
    const errMsg = 'Invalid params';

    let headerBuffer = new Uint8Array(headerLength);
    headerBuffer[0] = type;
    headerBuffer.set(new TextEncoder('utf-8').encode(hash), typeLength);
    
    let offset = headerLength;
    let contentBuffer;

    if (type == requestType.SEND_FILE_METADATA) {
        if (!optional || !optional.fileName || !optional.fileSize ||
            optional.fileType == undefined || !validate(optional)) {
            return errMsg;
        }

        contentBuffer = new Uint8Array(headerLength + fileNameLength + fileSizeLength + fileTypeLength);
        contentBuffer.set(headerBuffer);

        contentBuffer.set(new TextEncoder('utf-8').encode(optional.fileName), offset);
        offset += fileNameLength;

        contentBuffer.set(convertNumberToBuffer(optional.fileSize, fileSizeLength), offset);
        offset += fileSizeLength;

        contentBuffer.set(new TextEncoder('utf-8').encode(optional.fileType), offset);
        offset += fileTypeLength;
    } else if (type == requestType.GET_FILE_METADATA) {
        // if (!optional.ttl || !validate(optional)) {
        //     return errMsg;
        // }

        // let buffer = new Uint8Array(headerLength + ttlLength);
        // buffer.set(headerBuffer);

        // buffer[offset] = optional.ttl;

        // return buffer;

        contentBuffer = headerBuffer;
    } else if (type == requestType.SEND_PARTITION || type == requestType.GET_PARTITION) {
        if (
            !optional || !optional.partitionNumber
            || (type == requestType.SEND_PARTITION? !optional.fileBuffer : 0)
            || !validate(optional)
        ) {
            return errMsg;
        }

        contentBuffer = new Uint8Array(
            headerLength + partitionNumberLength + (type == requestType.SEND_PARTITION? fileBufferLength : 0)
        );
        contentBuffer.set(headerBuffer);

        contentBuffer.set(convertNumberToBuffer(optional.partitionNumber, partitionNumberLength), offset);
        offset += partitionNumberLength;

        if (type == requestType.SEND_PARTITION) {
            const startOffset = (optional.partitionNumber - 1) * fileBufferLength;
            if (startOffset >= optional.fileBuffer.byteLength) {
                return errMsg;
            }

            contentBuffer.set(
                new Uint8Array(optional.fileBuffer.slice(startOffset, startOffset + fileBufferLength)),
                offset
            );
            offset += fileBufferLength;
        }
    }

    if (optional && optional.host) {
        let temp = new Uint8Array(contentBuffer.byteLength + hostLength);
        temp.set(contentBuffer);

        temp.set(optional.host.split(':')[0].split('.').map(ipPartition => parseInt(ipPartition)), offset);
        offset += ipLength;

        temp.set(convertNumberToBuffer(optional.host.split(':')[1], portLength), offset);

        contentBuffer = temp;
    }

    return contentBuffer;
};

const unpack = async (buffer) => {
    const errMsg = 'Invalid package size';

    const type = buffer[0];
    const hash = new TextDecoder('utf-8').decode(buffer.slice(typeLength, typeLength + hashLength));

    let offset = headerLength;
    let optional = {};
    
    if (type == requestType.SEND_FILE_METADATA) {
        const estimatedLength = headerLength + fileNameLength + fileSizeLength + fileTypeLength;
        if (buffer.byteLength != estimatedLength && buffer.byteLength != estimatedLength + hostLength) {
            return errMsg;
        }

        optional.fileName = (new TextDecoder('utf-8').decode(buffer.slice(offset, offset + fileNameLength)))
        .replace(/\0/g, '');
        offset += fileNameLength;

        optional.fileSize = convertBufferToNumber(buffer.slice(offset, offset + fileSizeLength));
        offset += fileSizeLength;

        optional.fileType = (new TextDecoder('utf-8').decode(buffer.slice(offset, offset + fileTypeLength)))
        .replace(/\0/g, '');
        offset += fileTypeLength;
    } else if (type == requestType.GET_FILE_METADATA) {
        if (
            buffer.byteLength != headerLength /* + ttlLength */ &&
            buffer.byteLength != headerLength /* + ttlLength */ + hostLength
        ) {
            return errMsg;
        }

        // optional.ttl = buffer[offset];
        // offset += ttlLength;
    } else if (type == requestType.SEND_PARTITION || type == requestType.GET_PARTITION) {
        const estimatedLength = headerLength + partitionNumberLength + 
                                (type == requestType.SEND_PARTITION? fileBufferLength : 0);

        if (buffer.byteLength != estimatedLength && buffer.byteLength != estimatedLength + hostLength) {
            return errMsg;
        }

        optional.partitionNumber = convertBufferToNumber(buffer.slice(offset, offset + partitionNumberLength));
        offset += partitionNumberLength;

        if (type == requestType.SEND_PARTITION) {
            optional.fileBuffer = buffer.slice(offset, offset + fileBufferLength);
            offset += fileBufferLength;
        }
    }

    if (offset != buffer.byteLength) {
        optional.host = buffer.slice(offset, offset + ipLength).join('.');
        offset += ipLength;

        optional.host += ':' + convertBufferToNumber(buffer.slice(offset, offset + portLength));
    }

    return { type, hash, optional };
};

class Packet {
    type;      // Number
    hash;      // String
    optional;  // Object
    buffer;    // Uint8Array

    constructor (type, hash, optional) {
        this.type = type;
        this.hash = hash;
        this.optional = optional;
    }

    static async fromBuffer(buffer) {
        const response = await unpack(new Uint8Array(buffer));
        let packet = new Packet(response.type, response.hash, response.optional);
        packet.buffer = buffer;
        return packet;
    }

    async pack() {
        this.buffer = await pack(this.type, this.hash, this.optional);
        return this.buffer;
    }

    static get partitionLength() {
        return fileBufferLength;
    }
};

// END PROTOCOL

try {
    if (module != undefined) {
        module.exports = { Packet, requestType };
    }
} catch {}