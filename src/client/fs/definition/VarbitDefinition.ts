import { ByteBuffer } from "../../util/ByteBuffer";
import { Definition } from "./Definition";

export class VarbitDefinition extends Definition {
    baseVar!: number;

    startBit!: number;

    endBit!: number;

    constructor(id: number) {
        super(id);
    }

    override decodeOpcode(opcode: number, buffer: ByteBuffer): void {
        if (opcode == 1) {
            this.baseVar = buffer.readUnsignedShort();
            this.startBit = buffer.readUnsignedByte();
            this.endBit = buffer.readUnsignedByte();
        }
    }
}
