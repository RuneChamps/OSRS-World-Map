export class ByteBuffer {
    private readonly _data: Int8Array;

    public offset: number = 0;

    constructor(dataOrSize: Int8Array | ArrayBuffer | number) {
        if (dataOrSize instanceof Int8Array) {
            this._data = dataOrSize;
        } else if (dataOrSize instanceof ArrayBuffer) {
            this._data = new Int8Array(dataOrSize);
        } else {
            this._data = new Int8Array(dataOrSize);
        }
    }

    readByte(): number {
        return this._data[this.offset++];
    }

    readUnsignedByte(): number {
        return this.readByte() & 0xff;
    }

    readShort(): number {
        return (
            (((this.readUnsignedByte() << 8) | this.readUnsignedByte()) <<
                16) >>
            16
        );
    }

    readUnsignedShort(): number {
        return this.readShort() & 0xffff;
    }

    readMedium(): number {
        return (
            (this.readUnsignedByte() << 16) |
            (this.readUnsignedByte() << 8) |
            this.readUnsignedByte()
        );
    }

    readInt(): number {
        return (
            (this.readUnsignedByte() << 24) |
            (this.readUnsignedByte() << 16) |
            (this.readUnsignedByte() << 8) |
            this.readUnsignedByte()
        );
    }

    readBigSmart(): number {
        if (this.getByte(this.offset) < 0) {
            return this.readInt() & 0x7fffffff;
        } else if (this.getUnsignedShort(this.offset) === 32767) {
            this.readShort();
            return -1;
        } else {
            return this.readUnsignedShort();
        }
    }

    readUnsignedSmart(): number {
        if (this.getUnsignedByte(this.offset) < 128) {
            return this.readUnsignedByte();
        } else {
            return this.readUnsignedShort() - 32768;
        }
    }

    readSmart2(): number {
        if (this.getByte(this.offset) >= 0) {
            return this.readUnsignedByte() - 64;
        } else {
            return this.readUnsignedShort() - 49152;
        }
    }

    readSmart3(): number {
        let i = 0;
        let i_33_ = this.readUnsignedSmart();
        while (i_33_ == 32767) {
            i_33_ = this.readUnsignedSmart();
            i += 32767;
        }
        i += i_33_;
        return i;
    }

    readString(): string {
        let str = "";
        while (this.getByte(this.offset) !== 0) {
            str += String.fromCharCode(this.readUnsignedByte());
        }
        this.readByte();
        return str;
    }

    readNullString(): string | undefined {
        if (this.getByte(this.offset) == 0) {
            this.offset++;
            return undefined;
        } else {
            return this.readString();
        }
    }

    getByte(offset: number): number {
        return this._data[offset];
    }

    getUnsignedByte(offset: number): number {
        return this.getByte(offset) & 0xff;
    }

    getShort(offset: number): number {
        return (
            (this.getUnsignedByte(offset) << 8) |
            this.getUnsignedByte(offset + 1)
        );
    }

    getUnsignedShort(offset: number): number {
        return this.getShort(offset) & 0xffff;
    }

    getInt(offset: number): number {
        return (
            (this.getUnsignedByte(offset) << 24) |
            (this.getUnsignedByte(offset + 1) << 16) |
            (this.getUnsignedByte(offset + 2) << 8) |
            this.getUnsignedByte(offset + 3)
        );
    }

    readBytes(amount: number): Int8Array {
        const bytes = this._data.subarray(this.offset, this.offset + amount);
        this.offset += amount;
        return bytes;
    }

    readUnsignedBytes(amount: number): Uint8Array {
        const bytes = new Uint8Array(this._data.buffer).subarray(
            this.offset,
            this.offset + amount
        );
        this.offset += amount;
        return bytes;
    }

    writeBytes(bytes: Int8Array): void {
        this._data.set(bytes, this.offset);
        this.offset += bytes.length;
    }

    writeInt(v: number) {
        this._data[this.offset++] = v >> 24;
        this._data[this.offset++] = v >> 16;
        this._data[this.offset++] = v >> 8;
        this._data[this.offset++] = v;
    }

    setInt(offset: number, v: number) {
        this._data[offset++] = v >> 24;
        this._data[offset++] = v >> 16;
        this._data[offset++] = v >> 8;
        this._data[offset++] = v;
    }

    get length(): number {
        return this._data.length;
    }

    get remaining(): number {
        return this.length - this.offset;
    }

    get data(): Int8Array {
        return this._data;
    }
}
