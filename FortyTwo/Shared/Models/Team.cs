using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    public class Team
    {
        List<Player> Players { get; set; } = new List<Player>();
        public List<Trick> Tricks { get; set; } = new List<Trick>();
        public int Points => Tricks.Sum(x => x.Value);
    }
}
