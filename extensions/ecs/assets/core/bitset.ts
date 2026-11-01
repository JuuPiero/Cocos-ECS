/** A growable bit set over component type ids (archetype masks, query filters). */
export class BitSet {
    words: Uint32Array;

    constructor(words = 2) {
        this.words = new Uint32Array(words);
    }

    static of(ids: Iterable<number>): BitSet {
        const b = new BitSet();
        for (const id of ids) b.add(id);
        return b;
    }

    add(id: number): this {
        const w = id >>> 5;
        if (w >= this.words.length) {
            const n = new Uint32Array(Math.max(w + 1, this.words.length * 2));
            n.set(this.words);
            this.words = n;
        }
        this.words[w] |= 1 << (id & 31);
        return this;
    }

    has(id: number): boolean {
        const w = id >>> 5;
        return w < this.words.length && (this.words[w] & (1 << (id & 31))) !== 0;
    }

    /** Every bit of `other` is set here. */
    hasAll(other: BitSet): boolean {
        const o = other.words;
        for (let i = 0; i < o.length; i++) {
            const mine = i < this.words.length ? this.words[i] : 0;
            if ((mine & o[i]) !== o[i]) return false;
        }
        return true;
    }

    /** At least one bit of `other` is set here (true when `other` is empty). */
    hasAny(other: BitSet): boolean {
        const o = other.words;
        let empty = true;
        for (let i = 0; i < o.length; i++) {
            if (o[i] === 0) continue;
            empty = false;
            if (i < this.words.length && (this.words[i] & o[i]) !== 0) return true;
        }
        return empty;
    }

    /** No bit of `other` is set here. */
    hasNone(other: BitSet): boolean {
        const o = other.words;
        const n = Math.min(o.length, this.words.length);
        for (let i = 0; i < n; i++) if ((this.words[i] & o[i]) !== 0) return false;
        return true;
    }

    isEmpty(): boolean {
        for (let i = 0; i < this.words.length; i++) if (this.words[i] !== 0) return false;
        return true;
    }
}
