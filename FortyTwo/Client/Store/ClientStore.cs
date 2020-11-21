using System.Collections.Generic;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.DTO;

namespace FortyTwo.Client.Store
{
    public interface IClientStore
    {
        public List<Domino> Dominos { get; set; }
        public List<Game> Games { get; set; }
    }

    public class ClientStore : IClientStore
    {
        public List<Domino> Dominos { get; set; }
        public List<Game> Games { get; set; }
    }
}
