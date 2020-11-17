using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    public class Trick
    {
        public List<Domino> Dominos { get; set; } = new List<Domino>();
        public int Value => Dominos.Sum(x => x.Value) + 1;
    }
}
